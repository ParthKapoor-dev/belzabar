import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, Config, dedupeBy, FINDER_INDEX_TTL_MS, normalizeSearchText, numLike, scoreText, strOrNull } from "@belzabar/core";
import { pdApi, type RawPageListItem } from "./api/index";

export const PAGE_FINDER_CACHE_TTL_MS = FINDER_INDEX_TTL_MS;

const pageFinderCache = new Cache<PageFinderIndex>({
  dir: join(BELZ_CONFIG_DIR, "cache", "page-finder"),
  ttlMs: PAGE_FINDER_CACHE_TTL_MS,
  envScoped: false, // key already encodes the env (index-v1-<env>)
});

export interface PageFinderPage {
  id: string;
  referenceId: string;
  name: string;
  relativeRoute: string;
  status: string;
  updatedAt: number;
  url: string;
}

export interface PageFinderComponent {
  id: string;
  referenceId: string;
  name: string;
  status: string;
  updatedAt: number;
  url: string;
}

export interface PageFinderIndex {
  env: string;
  generatedAt: number;
  pages: PageFinderPage[];
  components: PageFinderComponent[];
  pageCount: number;
  componentCount: number;
}

export interface PageFinderPageMatch extends PageFinderPage {
  type: "page";
  score: number;
}

export interface PageFinderComponentMatch extends PageFinderComponent {
  type: "component";
  score: number;
}

export type PageFinderMatch = PageFinderPageMatch | PageFinderComponentMatch;

export async function loadOrBuildPageFinderIndex(
  options: { refresh: boolean }
): Promise<{ index: PageFinderIndex; source: "cache" | "fresh" }> {
  const cacheKey = `index-v1-${Config.activeEnv.name}`;
  if (!options.refresh) {
    const cached = await pageFinderCache.load(cacheKey);
    if (cached && cached.env === Config.activeEnv.name) {
      return { index: cached, source: "cache" };
    }
  }
  const index = await buildPageFinderIndex();
  await pageFinderCache.save(cacheKey, index);
  return { index, source: "fresh" };
}

async function buildPageFinderIndex(): Promise<PageFinderIndex> {
  const [rawPages, rawComponents] = await Promise.all([
    pdApi.fetchAllPages(),
    pdApi.fetchAllComponents(),
  ]);

  const pages = dedupeBy(
    rawPages.map(normalizePage).filter((p): p is PageFinderPage => p !== null),
    p => p.id
  );
  const components = dedupeBy(
    rawComponents.map(normalizeComponent).filter((c): c is PageFinderComponent => c !== null),
    c => c.id
  );

  return {
    env: Config.activeEnv.name,
    generatedAt: Date.now(),
    pages,
    components,
    pageCount: pages.length,
    componentCount: components.length,
  };
}

function normalizePage(raw: RawPageListItem): PageFinderPage | null {
  const id = strOrNull(raw.id);
  const name = strOrNull(raw.name);
  if (!id || !name) return null;
  const referenceId = strOrNull(raw.referenceId) ?? "";
  const status = strOrNull(raw.status) ?? "DRAFT";
  // PD page URLs need the DRAFT id so /ui-designer/page/<id> opens an
  // editable draft, not the published row (which the UI renders read-only).
  const draftId = status.toUpperCase() === "PUBLISHED" && referenceId ? referenceId : id;
  return {
    id,
    referenceId,
    name,
    relativeRoute: strOrNull(raw.relativeRoute) ?? "",
    status,
    updatedAt: numLike(raw.updatedAt) ?? 0,
    url: `${Config.cleanBaseUrl}/ui-designer/page/${draftId}`,
  };
}

function normalizeComponent(raw: RawPageListItem): PageFinderComponent | null {
  const id = strOrNull(raw.id);
  const name = strOrNull(raw.name);
  const referenceId = strOrNull(raw.referenceId) ?? "";
  if (!id || !name) return null;
  return {
    id,
    referenceId,
    name,
    status: strOrNull(raw.status) ?? "DRAFT",
    updatedAt: numLike(raw.updatedAt) ?? 0,
    // PD component URLs use the component NAME — the UI's /ui-designer/symbol/
    // route resolves by name and lands on the editable draft directly.
    url: `${Config.cleanBaseUrl}/ui-designer/symbol/${encodeURIComponent(name)}`,
  };
}

/**
 * One row per draft/published component pair (F19: search listed both). The
 * DRAFT row is kept (its `referenceId` names the published one); a PUBLISHED
 * row whose draft is not in the list stays.
 */
export function collapsePairs<T extends { id: string; referenceId: string; status: string }>(items: T[]): T[] {
  const draftIds = new Set(items.filter((i) => i.status.toUpperCase() !== "PUBLISHED").map((i) => i.id));
  return items.filter((i) => !(i.status.toUpperCase() === "PUBLISHED" && i.referenceId && draftIds.has(i.referenceId)));
}

export function searchPageIndex(
  index: PageFinderIndex,
  query: string,
  limit: number,
  type?: "page" | "component"
): { matches: PageFinderMatch[]; total: number } {
  const q = normalizeSearchText(query);
  if (!q) return { matches: [], total: 0 };

  const matches: PageFinderMatch[] = [];

  if (!type || type === "page") {
    for (const page of index.pages) {
      const score = scorePage(q, page);
      if (score > 0) matches.push({ type: "page", score, ...page });
    }
  }

  if (!type || type === "component") {
    for (const comp of collapsePairs(index.components)) {
      const score = scoreComponent(q, comp);
      if (score > 0) matches.push({ type: "component", score, ...comp });
    }
  }

  matches.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.name.localeCompare(b.name)
  );
  return { matches: matches.slice(0, Math.max(1, limit)), total: matches.length };
}

function scorePage(q: string, page: PageFinderPage): number {
  return Math.max(
    scoreText(q, page.name, 1.0),
    scoreText(q, page.relativeRoute, 0.85),
    scoreText(q, page.id, 0.7),
    scoreText(q, page.referenceId, 0.65),
  );
}

function scoreComponent(q: string, comp: PageFinderComponent): number {
  return Math.max(
    scoreText(q, comp.name, 1.0),
    scoreText(q, comp.id, 0.7),
    scoreText(q, comp.referenceId, 0.65),
  );
}

