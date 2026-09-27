// Read-side views over a HydratedPage — the single parser stack (the old
// string-based `parser/legacy.ts` extractors are gone). Used by `show`,
// `find-ad-methods` and the recursive analyzer.

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
 * root carries `isSymbol: true` and is not a child of itself (PD-25).
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

// -------- `show` views -------------------------------------------------------

export interface VariableView {
  name: string;
  type: string | null;
  initialValue: unknown;
}

export interface DerivedView {
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

export interface HttpCallSummary {
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
