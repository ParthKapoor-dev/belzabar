// Structural diff between two HydratedPage objects — the ONE diff engine.
//
// Used by `pd history diff` (two versions), `pd diff` (two environments) and
// the save / preflight edit summary (`editSummary`). Compares (PD-11):
//   - variables: added / removed / changed (type, initialValue, translateInitialValue)
//   - derived:   added / removed / changed (from, spec, filterFn, sideEffect)
//   - HTTP:      added / removed / changed (the whole raw request config, by callId)
//   - layout:    nodes added / removed / kind-changed / changed (props, events,
//                loop, field — children excluded)
//   - styles:    changed + line counts
//   - everything else in the config (inputs, events, helpText, __version, …)

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
  const varFp = (p: HydratedPage) =>
    new Map(p.variables.map((v) => [v.name, stableStringify([v.type, v.initialValue, v.translateInitialValue ?? null])] as const));
  const derFp = (p: HydratedPage) =>
    new Map(p.derived.map((d) => [d.name, stableStringify([d.from, d.spec, d.filterFn, d.sideEffect])] as const));
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
    styles: diffStyles(a.styles, b.styles),
    otherChanged,
  };
}

export function isIdentical(d: PageDiff): boolean {
  const sets = [d.variables, d.derived, d.httpRequests];
  return (
    sets.every((s) => s.added.length + s.removed.length + s.changed.length === 0) &&
    d.nodesAdded.length + d.nodesRemoved.length + d.nodesKindChanged.length + d.nodesChanged.length === 0 &&
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
  if (s.stylesChanged) lines.push("~ styles changed");
  add("~", "config", s.otherChanged);
  return lines;
}
