// Structural diff between two HydratedPage objects — the ONE diff engine.
//
// Used by `pd history diff` (two versions), `pd diff` (two environments) and
// the save / preflight edit summary (`editSummary`). Compares:
//   - variables: added / removed / changed (the whole raw entry:
//                compileType, description, variableMetadata, … count too);
//                a duplicate name is keyed `name#2`, `name#3` (never dropped)
//   - derived:   added / removed / changed (the whole raw entry)
//   - HTTP:      added / removed / changed (the whole raw request config, by callId)
//   - layout:    nodes added / removed / kind-changed / changed (props, events,
//                loop, field — children excluded), moved (new parent) and
//                parents whose common children were reordered
//   - styles:    changed + line counts
//   - everything else in the config (inputs, events, helpText, __version, …)
// `diffDetails` then says what differs inside each changed item: the
// differing leaf paths with the value on each side (`pd diff`, `history diff`).

import { isDeepStrictEqual } from "node:util";
import { findNode, walkParsed } from "./parser/index";
import type { HydratedPage, ParsedNode } from "./types/common";

export interface SetDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

interface StyleDiff {
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

// -------- what changed inside each changed item ------------------------------

/** One differing leaf: the value on each side (a missing `from` / `to` = absent on that side). */
interface PathChange {
  path: string;
  /** Multi-line text (code, templates): the 1-based first line that differs; from/to are that line. */
  line?: number;
  from?: unknown;
  to?: unknown;
}

export interface ChangeDetail {
  kind: "variable" | "derived" | "http" | "node" | "config" | "styles";
  /** Variable name, callId, node id or config key. */
  name: string;
  paths: PathChange[];
  /** More differing leaves than listed. */
  truncated?: boolean;
}

const VALUE_CAP = 300;
const PATHS_PER_ITEM = 10;

/** A value short enough to print: long strings and JSON are cut at VALUE_CAP. */
function brief(v: unknown): unknown {
  if (v === undefined || v === null || typeof v === "number" || typeof v === "boolean") return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.length <= VALUE_CAP) return v;
  return `${s.slice(0, VALUE_CAP)}… (${s.length} chars)`;
}

function leafChange(path: string, a: unknown, b: unknown): PathChange {
  if (typeof a === "string" && typeof b === "string" && (a.includes("\n") || b.includes("\n"))) {
    const la = a.replace(/\r\n?/g, "\n").split("\n");
    const lb = b.replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
    const out: PathChange = { path, line: i + 1 };
    if (i < la.length) out.from = brief(la[i]);
    if (i < lb.length) out.to = brief(lb[i]);
    return out;
  }
  const out: PathChange = { path };
  if (a !== undefined) out.from = brief(a);
  if (b !== undefined) out.to = brief(b);
  return out;
}

/** Leaf-most differing paths of two JSON values with both sides' values, capped at `cap`. */
export function pathChanges(a: unknown, b: unknown, cap = PATHS_PER_ITEM, path = "", out: PathChange[] = []): PathChange[] {
  if (out.length > cap || isDeepStrictEqual(a, b)) return out;
  const objA = !!a && typeof a === "object";
  const objB = !!b && typeof b === "object";
  if (!objA || !objB || Array.isArray(a) !== Array.isArray(b)) {
    out.push(leafChange(path || "(root)", a, b));
    return out;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    pathChanges(ra[k], rb[k], cap, Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k, out);
    if (out.length > cap) break;
  }
  return out;
}

function detail(kind: ChangeDetail["kind"], name: string, a: unknown, b: unknown): ChangeDetail {
  const paths = pathChanges(a, b);
  return paths.length > PATHS_PER_ITEM
    ? { kind, name, paths: paths.slice(0, PATHS_PER_ITEM), truncated: true }
    : { kind, name, paths };
}

/** name → raw entry, keyed like `byName` (a repeated name is `name#2`). */
function rawByName(items: Array<{ name: string; raw: unknown }>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  const seen = new Map<string, number>();
  for (const it of items) {
    const n = (seen.get(it.name) ?? 0) + 1;
    seen.set(it.name, n);
    m.set(n === 1 ? it.name : `${it.name}#${n}`, it.raw);
  }
  return m;
}

function ownFields(node: ParsedNode | null): unknown {
  const raw = (node?.raw && typeof node.raw === "object" ? node.raw : {}) as Record<string, unknown>;
  const { children: _c, ...own } = raw;
  return own;
}

/**
 * What differs inside every CHANGED item of `d` (variables, derived, HTTP
 * calls, nodes, other config keys, styles): the differing paths with the value
 * on each side (`from` = `a`, `to` = `b`). Added / removed items are already
 * named in `d`.
 */
export function diffDetails(a: HydratedPage, b: HydratedPage, d: PageDiff): ChangeDetail[] {
  const out: ChangeDetail[] = [];
  const va = rawVariableEntries(a);
  const vb = rawVariableEntries(b);
  const plainA = rawByName(va.plain);
  const plainB = rawByName(vb.plain);
  for (const n of d.variables.changed) out.push(detail("variable", n, plainA.get(n), plainB.get(n)));
  const derA = rawByName(va.derived);
  const derB = rawByName(vb.derived);
  for (const n of d.derived.changed) out.push(detail("derived", n, derA.get(n), derB.get(n)));
  const http = (p: HydratedPage) => new Map(p.httpRequests.map((h) => [h.callId ?? `idx:${h.index}`, h.raw] as const));
  const ha = http(a);
  const hb = http(b);
  for (const n of d.httpRequests.changed) out.push(detail("http", n, ha.get(n), hb.get(n)));
  for (const n of d.nodesChanged) out.push(detail("node", n, ownFields(findNode(a.layout, n)), ownFields(findNode(b.layout, n))));
  const ra = (a.rawConfiguration ?? {}) as Record<string, unknown>;
  const rb = (b.rawConfiguration ?? {}) as Record<string, unknown>;
  for (const k of d.otherChanged) {
    if (k === "variables.generated") {
      out.push(detail("config", k, (ra.variables as { generated?: unknown } | undefined)?.generated, (rb.variables as { generated?: unknown } | undefined)?.generated));
    } else out.push(detail("config", k, ra[k], rb[k]));
  }
  if (d.styles.changed) {
    const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
    const sa = new Set(lines(a.styles));
    const sb = new Set(lines(b.styles));
    const onlyA = [...sa].filter((l) => !sb.has(l));
    const onlyB = [...sb].filter((l) => !sa.has(l));
    out.push({
      kind: "styles",
      name: "styles",
      paths: [{ path: "styles", from: onlyA.slice(0, PATHS_PER_ITEM).map(brief), to: onlyB.slice(0, PATHS_PER_ITEM).map(brief) }],
      ...(onlyA.length > PATHS_PER_ITEM || onlyB.length > PATHS_PER_ITEM ? { truncated: true } : {}),
    });
  }
  return out;
}

/** Human lines for diffDetails: `~ kind name: path  from → to`. */
export function detailLines(changes: ChangeDetail[]): string[] {
  const show = (v: unknown) => (v === undefined ? "(absent)" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));
  const lines: string[] = [];
  for (const c of changes) {
    lines.push(`~ ${c.kind} ${c.name}`);
    for (const p of c.paths) lines.push(`    ${p.path}${p.line ? ` (line ${p.line})` : ""}: ${show(p.from)} → ${show(p.to)}`);
    if (c.truncated) lines.push("    …more differences");
  }
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
