// Normalized page snapshots (Stage 7, 7.14) — a stable, diff-friendly JSON of
// a page or component to keep in git as a test baseline, and a semantic
// comparison of a snapshot against the live page.
//
// Normalization (deterministic; re-running it on the same page gives the same
// bytes):
//   - only what the page IS: entity {name, entityType, relativeRoute,
//     dynamicRoute (parsed), aliasName} + the inner configuration. Everything
//     that changes on every save or differs per env is dropped: id,
//     referenceId, versionId, status, timestamps, createdBy/updatedBy,
//     ownerId, hostIds, themes, publishedAt;
//   - object keys sorted at every level; arrays keep their order (it is the
//     render / evaluation order);
//   - `_elementId` (a second generated id per node, renderer-internal) is
//     removed; node `id`s stay (they identify nodes and survive migration);
//   - empty editor bookkeeping (`__LAYOUT_CONFIG_METADATA: {}`,
//     `variableMetadata: {}`) is removed;
//   - multi-line strings (code, styles, templates) become {"$lines": [...]}
//     so a one-line code change is a one-line git diff; CRLF → LF.

import { isDeepStrictEqual } from "node:util";
import { parsePage } from "./parser/index";
import { editSummary, stableStringify, type EditSummary } from "./page-diff";
import type { HydratedPage, RawPageResponse } from "./types/common";

export const SNAPSHOT_VERSION = 1;

export interface PageSnapshot {
  belzSnapshot: typeof SNAPSHOT_VERSION;
  entity: {
    name: string;
    entityType: "PAGE" | "COMPONENT";
    relativeRoute?: string;
    dynamicRoute?: unknown;
    aliasName?: string;
  };
  config: unknown;
}

const DROP_KEYS = new Set(["_elementId"]);
const DROP_WHEN_EMPTY = new Set(["__LAYOUT_CONFIG_METADATA", "variableMetadata"]);

function isEmptyObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}

/** Recursively normalize a JSON value (see file header). */
export function normalizeValue(v: unknown): unknown {
  if (typeof v === "string") {
    const s = v.replace(/\r\n?/g, "\n");
    return s.includes("\n") ? { $lines: s.split("\n") } : s;
  }
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined || DROP_KEYS.has(k)) continue;
      if (DROP_WHEN_EMPTY.has(k) && isEmptyObject(val)) continue;
      out[k] = normalizeValue(val);
    }
    return out;
  }
  return v;
}

/** Inverse of the `$lines` encoding (the dropped keys stay dropped). */
export function denormalizeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(denormalizeValue);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === "$lines" && Array.isArray(o.$lines)) return (o.$lines as unknown[]).join("\n");
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = denormalizeValue(o[k]);
    return out;
  }
  return v;
}

export function snapshotOf(raw: RawPageResponse): PageSnapshot {
  const page = parsePage(raw);
  const r = raw as Record<string, unknown>;
  const entity: PageSnapshot["entity"] = { name: page.name, entityType: page.entityType };
  if (typeof r.relativeRoute === "string" && r.relativeRoute) entity.relativeRoute = r.relativeRoute;
  if (typeof r.dynamicRoute === "string" && r.dynamicRoute) {
    try {
      entity.dynamicRoute = normalizeValue(JSON.parse(r.dynamicRoute));
    } catch {
      entity.dynamicRoute = r.dynamicRoute;
    }
  }
  if (typeof r.aliasName === "string" && r.aliasName) entity.aliasName = r.aliasName;
  return { belzSnapshot: SNAPSHOT_VERSION, entity, config: normalizeValue(page.rawConfiguration ?? {}) };
}

/** The snapshot as file text: 2-space JSON (keys already sorted) + newline. */
export function serializeSnapshot(s: PageSnapshot): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

/** A HydratedPage rebuilt from a snapshot (for the diff engine). */
export function pageFromSnapshot(s: PageSnapshot): HydratedPage {
  return parsePage({
    id: "snapshot",
    name: s.entity.name,
    status: "DRAFT",
    isComponent: s.entity.entityType === "COMPONENT",
    configuration: JSON.stringify(denormalizeValue(s.config)),
  } as RawPageResponse);
}

export function isSnapshot(v: unknown): v is PageSnapshot {
  const o = v as PageSnapshot | null;
  return !!o && typeof o === "object" && o.belzSnapshot === SNAPSHOT_VERSION && !!o.entity && typeof o.entity.name === "string" && "config" in o;
}

export interface SnapshotComparison {
  identical: boolean;
  /** Entity fields that differ (name, entityType, relativeRoute, dynamicRoute, aliasName). */
  entityChanged: string[];
  /** Semantic change lists (the save/preflight edit summary; empty lists omitted). */
  changes: Partial<EditSummary>;
  /** Nodes present on both sides whose parent changed. */
  nodesMoved: string[];
  /** Parents whose (common) children are in a different order. */
  childrenReordered: string[];
  /** The normalized JSON differs but none of the lists above explain it (array order, …). */
  unclassified: boolean;
}

/** node id → parent id, and parent id → child ids in order. */
function treeShape(p: HydratedPage): { parent: Map<string, string>; kids: Map<string, string[]> } {
  const parent = new Map<string, string>();
  const kids = new Map<string, string[]>();
  const visit = (n: HydratedPage["layout"]) => {
    kids.set(n.nodeId, n.children.map((c) => c.nodeId));
    for (const c of n.children) {
      parent.set(c.nodeId, n.nodeId);
      visit(c);
    }
  };
  visit(p.layout);
  return { parent, kids };
}

/** Compare a stored snapshot (`base`) with a fresh one (`live`): what changed from base to live. */
export function compareSnapshots(base: PageSnapshot, live: PageSnapshot): SnapshotComparison {
  const identical = stableStringify(base) === stableStringify(live);
  const entityChanged = (["name", "entityType", "relativeRoute", "dynamicRoute", "aliasName"] as const).filter(
    (k) => !isDeepStrictEqual(base.entity[k], live.entity[k]),
  );
  const a = pageFromSnapshot(base);
  const b = pageFromSnapshot(live);
  const summary = editSummary(a, b);
  const changes: Partial<EditSummary> = {};
  for (const [k, v] of Object.entries(summary) as Array<[keyof EditSummary, EditSummary[keyof EditSummary]]>) {
    if (Array.isArray(v) ? v.length > 0 : v === true) (changes as Record<string, unknown>)[k] = v;
  }
  const ta = treeShape(a);
  const tb = treeShape(b);
  const nodesMoved = [...tb.parent].filter(([id, par]) => ta.parent.has(id) && ta.parent.get(id) !== par).map(([id]) => id);
  const childrenReordered: string[] = [];
  for (const [par, kidsB] of tb.kids) {
    const kidsA = ta.kids.get(par);
    if (!kidsA) continue;
    const common = new Set(kidsA.filter((k) => kidsB.includes(k)));
    const orderA = kidsA.filter((k) => common.has(k));
    const orderB = kidsB.filter((k) => common.has(k));
    if (!isDeepStrictEqual(orderA, orderB)) childrenReordered.push(par);
  }
  const explained =
    entityChanged.length > 0 || Object.keys(changes).length > 0 || nodesMoved.length > 0 || childrenReordered.length > 0;
  return { identical, entityChanged, changes, nodesMoved, childrenReordered, unclassified: !identical && !explained };
}
