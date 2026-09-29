// Recursive dependency analysis (`pd analyze`, `pd find-ad-methods -r`,
// `pd show -r`): a page/component, the components its layout references, and
// every AD method id their HTTP calls execute.
//
// PD-13 / F21: no `components.json` whitelist and no CWD files — every symbol
// reference in the layout is followed, resolved by exact component name via the
// API. PD-19: fetch/resolve failures during the walk are collected in
// `errors` (and surfaced by the commands), never swallowed.

import { CliError } from "@belzabar/core";
import { pdApi } from "./api/index";
import { cachedFetchPageConfigSwr, type ConfigSource } from "./cache";
import { adIdsOf, childComponentNames } from "./extract";
import { inferEntityType, parsePage } from "./parser/index";
import type { RawPageResponse } from "./types/wire";

export interface ReportNode {
  type: "PAGE" | "COMPONENT";
  name: string;
  id: string;
  adIds: string[];
  children: ReportNode[];
}

export interface AnalyzeError {
  id: string | null;
  name: string;
  message: string;
}

interface AnalyzerDeps {
  fetchPage(id: string): Promise<RawPageResponse | null>;
  componentIdByName(name: string): Promise<string | null>;
}

/** How many configs came from the cache (in TTL / stale) vs a fresh fetch. */
export type SourceCounts = Record<ConfigSource, number>;

export function emptySourceCounts(): SourceCounts {
  return { cache: 0, stale: 0, fresh: 0 };
}

/**
 * Cache-backed deps. `force` re-reads every config (OTH-R19: it used to
 * refresh the root only); `sources` counts where each config came from so the
 * command can say how much of the walk used cached data (OTH-R13).
 */
export function cacheDeps(force = false, sources?: SourceCounts): AnalyzerDeps {
  return {
    fetchPage: async (id) => {
      const r = await cachedFetchPageConfigSwr(id, force);
      if (sources) sources[r.source]++;
      return r.data;
    },
    componentIdByName: (name) => pdApi.fetchComponentIdByName(name),
  };
}

/** The warning for a walk that used cached configs, or null when all were fresh. */
export function cacheUseWarning(sources: SourceCounts): string | null {
  const cached = sources.cache + sources.stale;
  if (cached === 0) return null;
  return `ℹ ${cached} of ${cached + sources.fresh} config(s) came from the local cache (up to 1 h old); pass --force to re-read them.`;
}

const defaultDeps: AnalyzerDeps = cacheDeps(false);

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Walk `id` and every component it references. `visited` breaks cycles;
 * `errors` collects every failure (the partial tree is still returned).
 */
export async function analyzeItem(
  id: string,
  name: string,
  visited: Set<string>,
  errors: AnalyzeError[],
  deps: AnalyzerDeps = defaultDeps,
  /** The already-fetched config of `id` (the caller resolved it), so it is not read twice. */
  preloaded?: RawPageResponse,
): Promise<ReportNode> {
  visited.add(id);
  const node: ReportNode = { type: "PAGE", name, id, adIds: [], children: [] };

  let raw: RawPageResponse | null;
  try {
    raw = preloaded ?? (await deps.fetchPage(id));
  } catch (err) {
    errors.push({ id, name, message: message(err) });
    return node;
  }
  if (!raw) {
    errors.push({ id, name, message: `Page or component ${id} not found.` });
    return node;
  }
  const page = parsePage(raw);
  node.type = inferEntityType(raw);
  node.name = page.name || name;
  node.adIds = adIdsOf(page);

  const children = await Promise.all(
    childComponentNames(page).map(async (cName): Promise<ReportNode | null> => {
      let cId: string | null;
      try {
        cId = await deps.componentIdByName(cName);
      } catch (err) {
        errors.push({ id: null, name: cName, message: message(err) });
        return null;
      }
      if (!cId) {
        errors.push({ id: null, name: cName, message: `Component "${cName}" not found in this environment.` });
        return null;
      }
      if (visited.has(cId)) return null;
      return analyzeItem(cId, cName, visited, errors, deps);
    }),
  );
  node.children = children.filter((c): c is ReportNode => c !== null);
  return node;
}

// -------- reporting ---------------------------------------------------------

export function formatTreeLines(node: ReportNode, prefix = "", isLast = true): string[] {
  const lines: string[] = [];
  const marker = isLast ? "└── " : "├── ";
  lines.push(`${prefix}${marker}[${node.type}] ${node.name} (ID: ${node.id.substring(0, 8)}...)`);
  const nextPrefix = prefix + (isLast ? "    " : "│   ");

  node.adIds.forEach((adId, index) => {
    const isLastAd = index === node.adIds.length - 1 && node.children.length === 0;
    lines.push(`${nextPrefix}${isLastAd ? "└── " : "├── "}[AD] ${adId}`);
  });
  node.children.forEach((child, index) => {
    lines.push(...formatTreeLines(child, nextPrefix, index === node.children.length - 1));
  });
  return lines;
}

export function collectAllAdIds(nodes: ReportNode[]): string[] {
  const all = new Set<string>();
  const walk = (n: ReportNode) => {
    n.adIds.forEach((id) => all.add(id));
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return [...all].sort();
}

// -------- compliance ----------------------------------------------------------

interface RogueIdInfo {
  id: string;
  foundIn: string[];
}

export interface ComplianceResult {
  /** null when the walk was incomplete (unresolved/unfetchable components): not provable either way (OTH-R15). */
  isCompliant: boolean | null;
  rogueIds: RogueIdInfo[];
  missingIds: string[];
  commonIds: string[];
}

/** Parse a master AD-id list: ids separated by commas and/or whitespace. */
function parseMasterIds(text: string): Set<string> {
  return new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0));
}

export async function loadMasterIds(path: string): Promise<Set<string>> {
  const f = Bun.file(path);
  if (!(await f.exists())) {
    throw new CliError(`Master id file not found: ${path}`, { code: "MASTER_IDS_FILE_MISSING", details: { path } });
  }
  const ids = parseMasterIds(await f.text());
  if (ids.size === 0) {
    throw new CliError(`Master id file ${path} lists no ids.`, { code: "MASTER_IDS_FILE_EMPTY", details: { path } });
  }
  return ids;
}

/**
 * Generated AD ids vs an approved master list: rogue (not approved), missing,
 * common. `walkErrors` > 0 means part of the tree was never inspected, so a
 * clean result is not a pass: isCompliant is null (rogue ids still make it false).
 */
export function verifyCompliance(roots: ReportNode[], masterIds: Set<string>, walkErrors = 0): ComplianceResult {
  const generated = new Set(collectAllAdIds(roots));
  const foundIn = (adId: string): string[] => {
    const sources = new Set<string>();
    const walk = (n: ReportNode) => {
      if (n.adIds.includes(adId)) sources.add(n.name);
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    return [...sources];
  };
  const rogueIds: RogueIdInfo[] = [];
  const commonIds: string[] = [];
  for (const id of generated) {
    if (masterIds.has(id)) commonIds.push(id);
    else rogueIds.push({ id, foundIn: foundIn(id) });
  }
  const missingIds = [...masterIds].filter((id) => !generated.has(id));
  const isCompliant = rogueIds.length > 0 ? false : walkErrors > 0 ? null : true;
  return { isCompliant, rogueIds, missingIds: missingIds.sort(), commonIds: commonIds.sort() };
}
