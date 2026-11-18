// Read-side views over a HydratedPage. Used by `show`, `find-ad-methods` and
// the recursive analyzer.

import { walkParsed } from "./parser/nodes";
import type { HydratedPage, ParsedNode, PageHttpRequest } from "./types/common";

// -------- AD methods / child components -----------------------------------

/** Unique AD method ids referenced by the page's HTTP calls (all buckets), in order. */
export function adIdsOf(page: HydratedPage): string[] {
  const out = new Set<string>();
  for (const call of page.httpRequests) if (call.adId) out.add(call.adId);
  return [...out];
}

/**
 * Names of the components (symbol references) used in the layout, in order,
 * de-duplicated. The walk starts at the root's CHILDREN: a component's own
 * root carries `isSymbol: true` and is not a child of itself.
 */
export function childComponentNames(page: HydratedPage): string[] {
  const out = new Set<string>();
  for (const child of page.layout.children) {
    walkParsed(child, (node) => {
      if (node.kind === "SYMBOL" && node.symbolName.trim()) out.add(node.symbolName.trim());
    });
  }
  return [...out];
}

// -------- HTTP error handler --------------------------------------------------

/** The variable a handler target names: `{%x%}`, `this.x`, `pageContext.x` → `x`. */
function targetVariable(target: unknown): string | null {
  if (typeof target !== "string") return null;
  const t = target.trim();
  const tpl = t.match(/^\{%\s*([^%]+?)\s*%\}$/);
  if (tpl) return tpl[1]!;
  const ref = t.match(/^(?:this|pageContext)\.([\w$]+)$/);
  return ref ? ref[1]! : null;
}

/**
 * Variables an HTTP call writes when it FAILS: its `handler.error` entries
 * (a target string, or a `[target, expression]` pair like the success handler).
 */
export function errorVariables(call: PageHttpRequest): string[] {
  const out = new Set<string>();
  for (const e of call.errorHandler) {
    const v = targetVariable(Array.isArray(e) ? e[0] : e);
    if (v) out.add(v);
  }
  return [...out];
}

// -------- `show` views -------------------------------------------------------

interface VariableView {
  name: string;
  type: string | null;
  initialValue: unknown;
}

interface DerivedView {
  name: string;
  from: string[];
  spec: string | null;
  filterFn: string | null;
  sideEffect: boolean;
}

export function variablesView(page: HydratedPage): { userDefined: VariableView[]; derived: DerivedView[] } {
  return {
    userDefined: page.variables.map((v) => ({ name: v.name, type: v.type, initialValue: v.initialValue })),
    derived: page.derived.map((d) => ({
      name: d.name,
      from: d.from,
      spec: d.spec,
      filterFn: d.filterFn,
      sideEffect: d.sideEffect,
    })),
  };
}

interface HttpCallSummary {
  index: number;
  label: string;
  adId: string | null;
  serviceUuid: string | null;
  triggers: string[];
  hasEventMeta: boolean;
  eventMetaEmpty: boolean;
  outputBindings: string[];
  inProgressVar: string | null;
  method: string | null;
}

export function httpSummary(page: HydratedPage): HttpCallSummary[] {
  return page.httpRequests.map((c) => ({
    index: c.index,
    label: c.label,
    adId: c.adId,
    serviceUuid: c.serviceUuid,
    triggers: c.triggers,
    hasEventMeta: c.hasEventMeta,
    eventMetaEmpty: c.eventMetaEmpty,
    outputBindings: c.successMappings.map((m) => m.variable),
    inProgressVar: c.inProgressVar,
    method: c.method,
  }));
}

export interface HttpCallDetail {
  index: number;
  label: string;
  adId: string | null;
  serviceUuid: string | null;
  method: string | null;
  url: string | null;
  triggers: string[];
  triggerFilter: string | null;
  inputBindings: Array<{ fieldCode: string; bindingVariable: string }>;
  successMappings: Array<{ variable: string; expression: string }>;
  errorHandler: unknown[];
  inProgressVar: string | null;
  responseTransformSpec: string | null;
  hasEventMeta: boolean;
  eventMetaEmpty: boolean;
  eventMeta: Record<string, unknown> | null;
}

/** HTTP call by its 1-based index (the same `#n` every view shows), or null. */
export function httpDetail(page: HydratedPage, index: number): HttpCallDetail | null {
  const c: PageHttpRequest | undefined = page.httpRequests.find((h) => h.index === index);
  if (!c) return null;
  return {
    index: c.index,
    label: c.label,
    adId: c.adId,
    serviceUuid: c.serviceUuid,
    method: c.method,
    url: c.url,
    triggers: c.triggers,
    triggerFilter: c.triggerFilter,
    inputBindings: c.inputBindings.map((b) => ({ fieldCode: b.fieldCode, bindingVariable: b.bindingVariable ?? String(b.value ?? "") })),
    successMappings: c.successMappings.map((m) => ({ variable: m.variable, expression: m.expression })),
    errorHandler: c.errorHandler,
    inProgressVar: c.inProgressVar,
    responseTransformSpec: c.responseTransformSpec,
    hasEventMeta: c.hasEventMeta,
    eventMetaEmpty: c.eventMetaEmpty,
    eventMeta: c.eventMeta,
  };
}

export interface VarDetail {
  kind: "user-defined" | "derived";
  name: string;
  type: string | null;
  initialValue: unknown;
  from: string[] | null;
  spec: string | null;
  filterFn: string | null;
  sideEffect: boolean | null;
  bindingReferences: string[];
}

function bindingLocations(page: HydratedPage, name: string): string[] {
  const out: string[] = [];
  const text = page.rawConfigurationString;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (page.httpRequests.some((c) => c.triggers.includes(name))) out.push("http-trigger");
  if (new RegExp(`\\{%\\s*${escaped}(?:[.[\\s][^%]*)?%\\}`).test(text)) out.push("binding");
  if (page.httpRequests.some((c) => c.successMappings.some((m) => m.variable === name))) out.push("http-handler");
  if (page.httpRequests.some((c) => errorVariables(c).includes(name))) out.push("http-error-handler");
  if (page.httpRequests.some((c) => c.inProgressVar === name)) out.push("http-inProgress");
  return out;
}

export function varDetail(page: HydratedPage, name: string): VarDetail | null {
  const v = page.variables.find((x) => x.name === name);
  if (v) {
    return {
      kind: "user-defined",
      name: v.name,
      type: v.type,
      initialValue: v.initialValue,
      from: null,
      spec: null,
      filterFn: null,
      sideEffect: null,
      bindingReferences: bindingLocations(page, name),
    };
  }
  const d = page.derived.find((x) => x.name === name);
  if (d) {
    return {
      kind: "derived",
      name: d.name,
      type: null,
      initialValue: null,
      from: d.from,
      spec: d.spec,
      filterFn: d.filterFn,
      sideEffect: d.sideEffect,
      bindingReferences: bindingLocations(page, name),
    };
  }
  return null;
}

export interface ComponentTreeNode {
  name: string;
  id: string;
  isSymbol: boolean;
  hasEvents: boolean;
  childCount: number;
  children: ComponentTreeNode[];
}

export function componentTree(node: ParsedNode): ComponentTreeNode {
  return {
    name: node.tagName || "unnamed",
    id: node.nodeId.startsWith("__synthetic_") ? "" : node.nodeId,
    isSymbol: node.kind === "SYMBOL",
    hasEvents: !!(node.events && Object.keys(node.events).length > 0),
    childCount: node.children.length,
    children: node.children.map(componentTree),
  };
}

// -------- `show --find` ---------------------------------------------------------

export interface FoundNode {
  id: string;
  /** Component / tag name (`exp-form-field`, `button`, a symbol name). */
  component: string;
  kind: ParsedNode["kind"];
  /** Short visible text / label / binding, when the node has one. */
  label?: string;
  /** Key path in the inner config (elements.operations key prefix). */
  path: string;
  /** For nodes.insert next to this node: its parent's id and its index there. */
  parentId: string | null;
  index: number | null;
  /** How the query matched: id | component | text. */
  match: "id" | "component" | "text";
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** The text an agent would recognise the node by (innerHTML, label, placeholder, binding, symbol name). */
function nodeLabel(node: ParsedNode): string | undefined {
  const field = node.kind === "FORM_FIELD" ? node.field ?? {} : {};
  const candidates = [
    node.props.innerHTML,
    (field as Record<string, unknown>).label,
    node.props.label,
    (field as Record<string, unknown>).placeholder,
    node.props.placeholder,
    node.props["[innerHTML]"],
    node.props.text,
    node.props.template,
    node.kind === "SYMBOL" ? `<${node.symbolName}>` : undefined,
  ];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = stripTags(c);
    if (t) return t.length > 60 ? `${t.slice(0, 57)}…` : t;
  }
  // A button's text lives in its child span.
  if (node.kind === "BUTTON") {
    for (const child of node.children) {
      const t = nodeLabel(child);
      if (t) return t;
    }
  }
  return undefined;
}

function strings(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.values(obj as Record<string, unknown>).filter((v): v is string => typeof v === "string");
}

/**
 * Nodes matching `query`: an exact id / _elementId (that node), else an exact
 * component name (every node of it, case-insensitive), else a case-insensitive
 * substring of the node's label, id, any string prop / field / attr, its loop,
 * or its event handler code.
 */
export function findNodes(page: HydratedPage, query: string): FoundNode[] {
  const q = query.trim();
  const ql = q.toLowerCase();
  const rows: Array<FoundNode & { node: ParsedNode }> = [];
  const visit = (n: ParsedNode, parent: ParsedNode | null, index: number | null) => {
    rows.push({
      node: n,
      id: n.nodeId,
      component: n.tagName,
      kind: n.kind,
      label: nodeLabel(n),
      path: n.path,
      parentId: parent?.nodeId ?? null,
      index,
      match: "text",
    });
    n.children.forEach((c, i) => visit(c, n, c.path.endsWith("]") ? i : null));
  };
  visit(page.layout, null, null);
  const clean = ({ node: _n, ...rest }: FoundNode & { node: ParsedNode }): FoundNode => {
    const out = { ...rest };
    if (out.label === undefined) delete out.label;
    return out;
  };

  const byId = rows.filter((r) => r.id === q || r.node.elementId === q);
  if (byId.length) return byId.map((r) => clean({ ...r, match: "id" }));
  const byComponent = rows.filter((r) => r.component.toLowerCase() === ql);
  if (byComponent.length) return byComponent.map((r) => clean({ ...r, match: "component" }));
  return rows
    .filter((r) => {
      const n = r.node;
      const hay = [
        r.label ?? "",
        r.id,
        ...strings(n.props),
        ...(n.kind === "FORM_FIELD" ? strings(n.field) : []),
        ...strings((n.raw as { attrs?: unknown })?.attrs),
        n.loop ?? "",
        ...deepStrings(n.events),
      ];
      return hay.some((s) => s.toLowerCase().includes(ql));
    })
    .map((r) => clean({ ...r, match: "text" }));
}

/** Every string inside a JSON value (object values and array items, recursively). */
function deepStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) deepStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) deepStrings(x, out);
  return out;
}

// -------- `show --find`: code and request matches ---------------------------------

export interface CodeMatch {
  /** variable (initialValue), derived (spec, filterFn, from) or http (any field of the call). */
  where: "variable" | "derived" | "http";
  /** Variable name, or the HTTP call's `#index label`. */
  name: string;
  /** The HTTP call's callId (http matches). */
  callId?: string;
  /** The field that matched (`spec`, `request.body`, `meta.serviceCall.callId`, …). */
  field: string;
  /** 1-based line within a multi-line value. */
  line?: number;
  /** The matching line, trimmed (cut at 160 chars). */
  text: string;
}

/** Leaf strings of a value with their dotted paths (`handler.success[0][1]`). */
function leaves(v: unknown, path: string, out: Array<{ path: string; value: string }> = []): Array<{ path: string; value: string }> {
  if (typeof v === "string") out.push({ path, value: v });
  else if (typeof v === "number" || typeof v === "boolean") out.push({ path, value: String(v) });
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out);
  return out;
}

/** Matches of `ql` (lower-case) in one value: one per matching line. */
function matchLines(value: string, ql: string): Array<{ line?: number; text: string }> {
  if (!value.toLowerCase().includes(ql)) return [];
  const lines = value.split(/\r?\n/);
  const cut = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);
  if (lines.length === 1) return [{ text: cut(value.trim()) }];
  return lines.flatMap((l, i) => (l.toLowerCase().includes(ql) ? [{ line: i + 1, text: cut(l.trim()) }] : []));
}

/**
 * The non-layout half of `show --find`: a case-insensitive substring search
 * of variable initial values, derived variable code (spec, filterFn, from)
 * and every field of every HTTP call (callId, label, url, request body,
 * handlers, triggers, transform code, service-call meta).
 */
export function findInCode(page: HydratedPage, query: string): CodeMatch[] {
  const ql = query.trim().toLowerCase();
  if (!ql) return [];
  const out: CodeMatch[] = [];
  const push = (base: Omit<CodeMatch, "field" | "line" | "text">, field: string, value: string) => {
    for (const m of matchLines(value, ql)) out.push({ ...base, field, ...m });
  };
  for (const v of page.variables) {
    if (v.initialValue === null || v.initialValue === undefined) continue;
    for (const leaf of leaves(v.initialValue, "initialValue")) push({ where: "variable", name: v.name }, leaf.path, leaf.value);
  }
  for (const d of page.derived) {
    if (d.spec) push({ where: "derived", name: d.name }, "spec", d.spec);
    if (d.filterFn) push({ where: "derived", name: d.name }, "filterFn", d.filterFn);
    push({ where: "derived", name: d.name }, "from", d.from.join(", "));
  }
  for (const c of page.httpRequests) {
    const base = { where: "http" as const, name: `#${c.index} ${c.label.trim()}`, ...(c.callId ? { callId: c.callId } : {}) };
    for (const leaf of leaves(c.raw, "")) push(base, leaf.path, leaf.value);
  }
  return out;
}
