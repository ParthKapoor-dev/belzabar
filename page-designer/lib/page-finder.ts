import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, Config } from "@belzabar/core";
import { fetchAllPages, fetchAllComponents, type RawPageListItem } from "./api";

export const PAGE_FINDER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const pageFinderCache = new Cache<PageFinderIndex>({
  dir: join(BELZ_CONFIG_DIR, "cache", "page-finder"),
  ttlMs: PAGE_FINDER_CACHE_TTL_MS,
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
    fetchAllPages(),
    fetchAllComponents(),
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
  const id = getString(raw.id);
  const name = getString(raw.name);
  if (!id || !name) return null;
  return {
    id,
    referenceId: getString(raw.referenceId) ?? "",
    name,
    relativeRoute: getString(raw.relativeRoute) ?? "",
    status: getString(raw.status) ?? "DRAFT",
    updatedAt: getNumber(raw.updatedAt) ?? 0,
    url: `${Config.cleanBaseUrl}/ui-designer/page/${id}`,
  };
}

function normalizeComponent(raw: RawPageListItem): PageFinderComponent | null {
  const id = getString(raw.id);
  const name = getString(raw.name);
  const referenceId = getString(raw.referenceId) ?? "";
  if (!id || !name) return null;
  return {
    id,
    referenceId,
    name,
    status: getString(raw.status) ?? "DRAFT",
    updatedAt: getNumber(raw.updatedAt) ?? 0,
    url: `${Config.cleanBaseUrl}/ui-designer/symbol/${referenceId || id}`,
  };
}

export function searchPageIndex(
  index: PageFinderIndex,
  query: string,
  limit: number,
  type?: "page" | "component"
): PageFinderMatch[] {
  const q = normalize(query);
  if (!q) return [];

  const matches: PageFinderMatch[] = [];

  if (!type || type === "page") {
    for (const page of index.pages) {
      const score = scorePage(q, page);
      if (score > 0) matches.push({ type: "page", score, ...page });
    }
  }

  if (!type || type === "component") {
    for (const comp of index.components) {
      const score = scoreComponent(q, comp);
      if (score > 0) matches.push({ type: "component", score, ...comp });
    }
  }

  matches.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.name.localeCompare(b.name)
  );
  return matches.slice(0, Math.max(1, limit));
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

function scoreText(query: string, value: string, weight: number): number {
  const normalizedValue = normalize(value);
  if (!normalizedValue) return 0;

  let base = 0;
  if (normalizedValue === query) {
    base = 1000;
  } else if (normalizedValue.startsWith(query)) {
    base = 900;
  } else if (containsWordStart(normalizedValue, query)) {
    base = 850;
  } else if (normalizedValue.includes(query)) {
    base = 760;
  } else {
    base = fuzzyScore(query, normalizedValue);
  }

  if (base <= 0) return 0;
  return Math.max(1, Math.round(base * weight));
}

function containsWordStart(value: string, query: string): boolean {
  if (value.startsWith(query)) return true;
  return (
    value.includes(` ${query}`) ||
    value.includes(`.${query}`) ||
    value.includes(`_${query}`) ||
    value.includes(`-${query}`) ||
    value.includes(`/${query}`)
  );
}

function fuzzyScore(query: string, value: string): number {
  const q = query.trim();
  if (!q) return 0;

  let best = 0;

  const subsequence = subsequenceScore(q, value);
  best = Math.max(best, subsequence);

  const tokens = tokenize(value);
  const maxDistance = Math.max(1, Math.floor(q.length * 0.4));

  for (const token of tokens) {
    if (token.length < 2) continue;
    if (Math.abs(token.length - q.length) > maxDistance + 4) continue;

    const distance = levenshtein(q, token);
    if (distance > maxDistance) continue;

    const score = 640 - distance * 120 - Math.abs(token.length - q.length) * 12;
    best = Math.max(best, score);
  }

  return Math.max(0, best);
}

function subsequenceScore(query: string, value: string): number {
  let qIndex = 0;
  let vIndex = 0;

  while (qIndex < query.length && vIndex < value.length) {
    if (query[qIndex] === value[vIndex]) {
      qIndex += 1;
    }
    vIndex += 1;
  }

  if (qIndex < query.length) return 0;

  const density = query.length / Math.max(1, value.length);
  const lengthBoost = Math.min(1, query.length / 8);
  return Math.round(420 + density * 180 + lengthBoost * 40);
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[rows - 1][cols - 1];
}

function tokenize(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/g)
    .map(t => t.trim())
    .filter(Boolean);
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return [...map.values()];
}

function getString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
