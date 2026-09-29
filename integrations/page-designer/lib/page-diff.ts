// Structural diff between two HydratedPage objects — the ONE diff engine.
//
// Used by `pd history diff` (two versions), `pd diff` (two environments) and
// the save / preflight edit summary (`editSummary`). Compares (PD-11):
//   - variables: added / removed / changed (the whole raw entry, OTH-R12:
//                compileType, description, variableMetadata, … count too);
//                a duplicate name is keyed `name#2`, `name#3` (never dropped)
//   - derived:   added / removed / changed (the whole raw entry)
//   - HTTP:      added / removed / changed (the whole raw request config, by callId)
//   - layout:    nodes added / removed / kind-changed / changed (props, events,
//                loop, field — children excluded), moved (new parent) and
//                parents whose common children were reordered (OTH-R12)
//   - styles:    changed + line counts
//   - everything else in the config (inputs, events, helpText, __version, …)

import { isDeepStrictEqual } from "node:util";
import { walkParsed } from "./parser/index";
import type { HydratedPage, ParsedNode } from "./types/common";

export interface SetDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface StyleDiff {
  changed: boolean;
  linesAdded: number;
  linesRemoved: number;
}

export interface PageDiff {
  variables: SetDiff;
  derived: SetDiff;
  httpRequests: SetDiff;
  nodeCountBefore: number;
  nodeCountAfter: number;
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesKindChanged: Array<{ nodeId: string; before: string; after: string }>;
  /** Nodes present on both sides whose own props/events/loop/field differ. */
  nodesChanged: string[];
  /** Nodes present on both sides whose parent changed. */
  nodesMoved: string[];
  /** Parents whose (common) children are in a different order. */
  childrenReordered: string[];
  styles: StyleDiff;
  /** Other top-level config keys that differ (inputs, events, helpText, …). */
  otherChanged: string[];
}

/** Stable JSON (sorted keys) so equal structures compare equal regardless of key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function countNodes(page: HydratedPage): number {
  let n = 0;
  walkParsed(page.layout, () => {
    n++;
  });
  return n;
}

function nodeFingerprint(node: ParsedNode): string {
  const raw = (node.raw && typeof node.raw === "object" ? node.raw : {}) as Record<string, unknown>;
  const { children: _c, ...own } = raw;
  return stableStringify(own);
}

function collectNodes(page: HydratedPage): Map<string, { kind: string; fp: string }> {
  const m = new Map<string, { kind: string; fp: string }>();
  walkParsed(page.layout, (node) => {
    m.set(node.nodeId, { kind: node.kind, fp: nodeFingerprint(node) });
  });
  return m;
}

/** node id → parent id, and parent id → child ids in order. */
export function treeShape(p: HydratedPage): { parent: Map<string, string>; kids: Map<string, string[]> } {
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

/** Moved nodes and reordered parents between two layouts. */
function treeChanges(a: HydratedPage, b: HydratedPage): { nodesMoved: string[]; childrenReordered: string[] } {
  const ta = treeShape(a);
  const tb = treeShape(b);
  const nodesMoved = [...tb.parent].filter(([id, par]) => ta.parent.has(id) && ta.parent.get(id) !== par).map(([id]) => id);
  const childrenReordered: string[] = [];
  for (const [par, kidsB] of tb.kids) {
    const kidsA = ta.kids.get(par);
    if (!kidsA) continue;
    const inB = new Set(kidsB);
    const orderA = kidsA.filter((k) => inB.has(k));
    const inA = new Set(orderA);
    const orderB = kidsB.filter((k) => inA.has(k));
    if (orderA.join("\u0000") !== orderB.join("\u0000")) childrenReordered.push(par);
  }
  return { nodesMoved, childrenReordered };
}

/** name → fingerprint; a repeated name gets `name#2`, `name#3` so no entry is dropped. */
function byName(items: Array<{ name: string; raw: unknown }>): Map<string, string> {
  const m = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const it of items) {
    const n = (seen.get(it.name) ?? 0) + 1;
    seen.set(it.name, n);
    m.set(n === 1 ? it.name : `${it.name}#${n}`, stableStringify(it.raw));
  }
  return m;
}

/**
 * The RAW variable entries, split into plain and derived. Read from the raw
 * config (not the parsed lists, which drop a duplicate name) so every entry
 * and every field is compared.
 */
function rawVariableEntries(p: HydratedPage): { plain: Array<{ name: string; raw: unknown }>; derived: Array<{ name: string; raw: unknown }> } {
  const inner = (p.rawConfiguration ?? {}) as {
    variables?: { userDefined?: unknown; derived?: unknown };
    context?: { properties?: unknown; derived?: unknown };
  };
  const plain: Array<{ name: string; raw: unknown }> = [];
  const derived: Array<{ name: string; raw: unknown }> = [];
  const ud = inner.variables?.userDefined;
  if (Array.isArray(ud) && ud.length > 0) {
    for (const e of ud) {
      if (!e || typeof e !== "object" || typeof (e as { name?: unknown }).name !== "string") continue;
      (Array.isArray((e as { from?: unknown }).from) ? derived : plain).push({ name: (e as { name: string }).name, raw: e });
    }
  } else if (Array.isArray(inner.context?.properties)) {
    for (const e of inner.context!.properties as unknown[]) {
      if (Array.isArray(e) && typeof e[0] === "string") plain.push({ name: e[0], raw: e });
    }
  }
  const rd = inner.variables?.derived ?? inner.context?.derived;
  if (Array.isArray(rd)) {
    for (const e of rd) {
      if (e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string") derived.push({ name: (e as { name: string }).name, raw: e });
    }
  }
  return { plain, derived };
}

/** Keyed diff: added / removed by key, changed when the fingerprints differ. */
function keyedDiff(before: Map<string, string>, after: Map<string, string>): SetDiff {
  const out: SetDiff = { added: [], removed: [], changed: [] };
  for (const [k, fp] of after) {
    const prior = before.get(k);
    if (prior === undefined) out.added.push(k);
    else if (prior !== fp) out.changed.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) out.removed.push(k);
  return out;
}

function diffStyles(before: string, after: string): StyleDiff {
  if (before === after) return { changed: false, linesAdded: 0, linesRemoved: 0 };
  const lines = (s: string) =>
    s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const beforeSet = new Set(lines(before));
  const afterSet = new Set(lines(after));
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const l of afterSet) if (!beforeSet.has(l)) linesAdded++;
  for (const l of beforeSet) if (!afterSet.has(l)) linesRemoved++;
  return { changed: true, linesAdded, linesRemoved };
}

const MODELLED_KEYS = new Set(["layout", "styles", "variables", "httpRequests", "http", "context"]);

/** Structural diff: `a` is the "before"/"from" page, `b` is the "after"/"to" page. */
export function diffPages(a: HydratedPage, b: HydratedPage): PageDiff {
  const varFp = (p: HydratedPage) => byName(rawVariableEntries(p).plain);
  const derFp = (p: HydratedPage) => byName(rawVariableEntries(p).derived);
  const httpFp = (p: HydratedPage) =>
    new Map(p.httpRequests.map((h) => [h.callId ?? `idx:${h.index}`, stableStringify(h.raw)] as const));

  const nodesA = collectNodes(a);
  const nodesB = collectNodes(b);
  const nodesAdded: string[] = [];
  const nodesRemoved: string[] = [];
  const nodesChanged: string[] = [];
  const nodesKindChanged: Array<{ nodeId: string; before: string; after: string }> = [];
  for (const [id, nb] of nodesB) {
    const na = nodesA.get(id);
    if (!na) nodesAdded.push(id);
    else if (na.kind !== nb.kind) nodesKindChanged.push({ nodeId: id, before: na.kind, after: nb.kind });
    else if (na.fp !== nb.fp) nodesChanged.push(id);
  }
  for (const id of nodesA.keys()) if (!nodesB.has(id)) nodesRemoved.push(id);

  const ra = (a.rawConfiguration ?? {}) as Record<string, unknown>;
  const rb = (b.rawConfiguration ?? {}) as Record<string, unknown>;
  const otherChanged: string[] = [];
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (MODELLED_KEYS.has(k)) continue;
    if (stableStringify(ra[k]) !== stableStringify(rb[k])) otherChanged.push(k);
  }
  // variables.generated is editor-owned and not in the modelled lists.
  const genA = (ra.variables as { generated?: unknown } | undefined)?.generated;
  const genB = (rb.variables as { generated?: unknown } | undefined)?.generated;
  if (stableStringify(genA ?? []) !== stableStringify(genB ?? [])) otherChanged.push("variables.generated");

  return {
    variables: keyedDiff(varFp(a), varFp(b)),
    derived: keyedDiff(derFp(a), derFp(b)),
    httpRequests: keyedDiff(httpFp(a), httpFp(b)),
    nodeCountBefore: countNodes(a),
    nodeCountAfter: countNodes(b),
    nodesAdded,
    nodesRemoved,
    nodesKindChanged,
    nodesChanged,
    ...treeChanges(a, b),
    styles: diffStyles(a.styles, b.styles),
    otherChanged,
  };
}

export function isIdentical(d: PageDiff): boolean {
  const sets = [d.variables, d.derived, d.httpRequests];
  return (
    sets.every((s) => s.added.length + s.removed.length + s.changed.length === 0) &&
    d.nodesAdded.length + d.nodesRemoved.length + d.nodesKindChanged.length + d.nodesChanged.length === 0 &&
    d.nodesMoved.length + d.childrenReordered.length === 0 &&
    !d.styles.changed &&
    d.otherChanged.length === 0
  );
}

/** The flat edit summary `save` / `preflight` report (one shape for both). */
export interface EditSummary {
  variablesAdded: string[];
  variablesRemoved: string[];
  variablesChanged: string[];
  derivedAdded: string[];
  derivedRemoved: string[];
  derivedChanged: string[];
  httpAdded: string[];
  httpRemoved: string[];
  httpChanged: string[];
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: string[];
  nodesMoved: string[];
  childrenReordered: string[];
  stylesChanged: boolean;
  otherChanged: string[];
}

export function editSummary(before: HydratedPage, after: HydratedPage): EditSummary {
  const d = diffPages(before, after);
  return {
    variablesAdded: d.variables.added,
    variablesRemoved: d.variables.removed,
    variablesChanged: d.variables.changed,
    derivedAdded: d.derived.added,
    derivedRemoved: d.derived.removed,
    derivedChanged: d.derived.changed,
    httpAdded: d.httpRequests.added,
    httpRemoved: d.httpRequests.removed,
    httpChanged: d.httpRequests.changed,
    nodesAdded: d.nodesAdded,
    nodesRemoved: d.nodesRemoved,
    nodesChanged: [...d.nodesChanged, ...d.nodesKindChanged.map((k) => k.nodeId)],
    nodesMoved: d.nodesMoved,
    childrenReordered: d.childrenReordered,
    stylesChanged: d.styles.changed,
    otherChanged: d.otherChanged,
  };
}

/** Human lines for an EditSummary ("+ variables: a, b"); empty when nothing changed. */
export function editSummaryLines(s: EditSummary): string[] {
  const lines: string[] = [];
  const add = (sign: string, label: string, names: string[]) => {
    if (names.length > 0) lines.push(`${sign} ${label}: ${names.join(", ")}`);
  };
  add("+", "variables", s.variablesAdded);
  add("-", "variables", s.variablesRemoved);
  add("~", "variables", s.variablesChanged);
  add("+", "derived", s.derivedAdded);
  add("-", "derived", s.derivedRemoved);
  add("~", "derived", s.derivedChanged);
  add("+", "http", s.httpAdded);
  add("-", "http", s.httpRemoved);
  add("~", "http", s.httpChanged);
  add("+", "nodes", s.nodesAdded);
  add("-", "nodes", s.nodesRemoved);
  add("~", "nodes", s.nodesChanged);
  add("↷", "nodes moved", s.nodesMoved);
  add("↕", "children reordered under", s.childrenReordered);
  if (s.stylesChanged) lines.push("~ styles changed");
  add("~", "config", s.otherChanged);
  return lines;
}

const DIFF_PATH_CAP = 20;

/** Config paths where `a` and `b` differ (leaf-most, capped at DIFF_PATH_CAP). */
export function differingPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length >= DIFF_PATH_CAP || isDeepStrictEqual(a, b)) return out;
  const objA = !!a && typeof a === "object";
  const objB = !!b && typeof b === "object";
  if (!objA || !objB || Array.isArray(a) !== Array.isArray(b)) {
    out.push(path || "(root)");
    return out;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    const sub = Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
    differingPaths(ra[k], rb[k], sub, out);
    if (out.length >= DIFF_PATH_CAP) break;
  }
  return out;
}
