// Legacy string-based extractors. The existing read commands (show, find,
// find-ad-methods, analyze) call these directly; the new validate command in
// Phase 6 switches to validateHydrated, but the others stay on these for now
// so we don't have to rewrite every presenter in one go.
//
// The shapes they return live in ../types/legacy.ts. The new validator
// produces richer output; prefer validateHydrated() for new callers.

import type {
  ComponentTreeNode,
  EventHandlerInfo,
  HttpCallSummary,
  NormalizedDerived,
  NormalizedVariable,
} from "../types/legacy";
import type {
  RawConfiguration,
  RawHttpRequestItem,
  RawLayoutNode,
} from "../types/wire";

export function cleanAdId(url: string): string | null {
  const pattern = /\/rest\/api\/automation\/chain\/execute\/([a-zA-Z0-9]+)/;
  const match = url.match(pattern);
  return match?.[1] ?? null;
}

function parseConfig(configStr: string): RawConfiguration | null {
  try {
    return JSON.parse(configStr);
  } catch {
    return null;
  }
}

function getHttpItems(config: RawConfiguration): RawHttpRequestItem[] {
  return [
    ...(config.httpRequests?.userDefined ?? []),
    ...(config.http ?? []),
  ];
}

function getLayoutChildren(node: RawLayoutNode): RawLayoutNode[] {
  if (!node.children) return [];
  if (Array.isArray(node.children)) return node.children;
  return Object.values(node.children);
}

export function extractReferences(configStr: string, whitelist: Set<string>) {
  const adIds = new Set<string>();
  const componentNames = new Set<string>();
  const config = parseConfig(configStr);
  if (!config) return { adIds: [], componentNames: [] };

  getHttpItems(config).forEach((item) => {
    const url = item.request?.url;
    if (url) {
      const id = cleanAdId(url);
      if (id) adIds.add(id);
    }
  });

  const traverse = (node?: RawLayoutNode) => {
    if (!node) return;
    if (node.name && whitelist.has(node.name)) componentNames.add(node.name);
    getLayoutChildren(node).forEach(traverse);
  };
  traverse(config.layout);

  return { adIds: Array.from(adIds), componentNames: Array.from(componentNames) };
}

export function extractDirectChildComponentNames(configStr: string): string[] {
  const config = parseConfig(configStr);
  if (!config) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  const walk = (node: RawLayoutNode | undefined) => {
    if (!node) return;
    if (node.isSymbol) {
      const name = node.name?.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    getLayoutChildren(node).forEach(walk);
  };
  walk(config.layout);
  return names;
}

export function extractVariables(configStr: string): {
  userDefined: NormalizedVariable[];
  derived: NormalizedDerived[];
} {
  const config = parseConfig(configStr);
  if (!config) return { userDefined: [], derived: [] };

  const userDefined: NormalizedVariable[] = [];
  if (config.variables?.userDefined) {
    for (const item of config.variables.userDefined) {
      if (item && typeof item === "object" && "name" in item) {
        userDefined.push({
          name: item.name,
          type: item.type ?? null,
          initialValue: item.initialValue ?? null,
        });
      }
    }
  } else if (config.context?.properties) {
    for (const item of config.context.properties) {
      if (Array.isArray(item) && item.length >= 2) {
        userDefined.push({
          name: item[0] as string,
          type: null,
          initialValue: item[1],
        });
      }
    }
  }

  const rawDerived = config.variables?.derived ?? config.context?.derived ?? [];
  const derived: NormalizedDerived[] = rawDerived.map((d) => ({
    name: d.name,
    from: d.from ?? [],
    spec: d.spec ?? null,
    filterFn: d.filterFn ?? null,
    sideEffect: d.sideEffect === true,
  }));

  return { userDefined, derived };
}

export function extractHttpSummary(configStr: string): HttpCallSummary[] {
  const config = parseConfig(configStr);
  if (!config) return [];
  const items = getHttpItems(config);
  return items.map((item, idx) => {
    const sc = item.meta?.serviceCall;
    const url = item.request?.url;

    const outputBindings: string[] = [];
    if (item.handler?.success) {
      for (const entry of item.handler.success) {
        if (Array.isArray(entry) && typeof entry[0] === "string") {
          const varMatch = entry[0].match(/\{%([^%]+)%\}/);
          if (varMatch?.[1]) outputBindings.push(varMatch[1]);
        }
      }
    }

    const triggers = (item.trigger ?? []).map((t) => t.replace(/^this\./, ""));
    const eventMeta = sc?.eventMeta;

    return {
      index: idx + 1,
      label: sc?.label ?? "(unnamed)",
      adId: url ? cleanAdId(url) : null,
      serviceUuid: sc?.serviceUuid ?? null,
      triggers,
      hasEventMeta: eventMeta !== undefined,
      eventMetaEmpty: eventMeta !== undefined && Object.keys(eventMeta).length === 0,
      outputBindings,
      inProgressVar: item.handler?.inProgress?.match(/\{%([^%]+)%\}/)?.[1] ?? null,
      method: item.request?.method ?? null,
    };
  });
}

export function extractBindingReferences(configStr: string): string[] {
  const seen = new Set<string>();
  const regex = /\{%([^%]+)%\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(configStr)) !== null) {
    if (match[1]) seen.add(match[1]);
  }
  return Array.from(seen);
}

export function extractEventHandlers(configStr: string): EventHandlerInfo[] {
  const config = parseConfig(configStr);
  if (!config) return [];
  const results: EventHandlerInfo[] = [];
  const walk = (node: RawLayoutNode | undefined) => {
    if (!node) return;
    if (node.events && typeof node.events === "object") {
      const eventTypes = Object.keys(node.events);
      if (eventTypes.length > 0) {
        results.push({
          nodeId: node.id ?? node._elementId ?? "unknown",
          nodeName: node.name ?? "unnamed",
          eventTypes,
        });
      }
    }
    getLayoutChildren(node).forEach(walk);
  };
  walk(config.layout);
  return results;
}

export function extractComponentTree(configStr: string): ComponentTreeNode | null {
  const config = parseConfig(configStr);
  if (!config?.layout) return null;
  const buildNode = (node: RawLayoutNode): ComponentTreeNode => {
    const children = getLayoutChildren(node);
    return {
      name: node.name ?? "unnamed",
      id: node.id ?? node._elementId ?? "",
      isSymbol: node.isSymbol === true,
      hasEvents: !!(node.events && Object.keys(node.events).length > 0),
      childCount: children.length,
      children: children.map(buildNode),
    };
  };
  return buildNode(config.layout);
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

export function extractHttpDetail(configStr: string, index: number): HttpCallDetail | null {
  const config = parseConfig(configStr);
  if (!config) return null;
  const items = getHttpItems(config);
  const item = items[index - 1];
  if (!item) return null;
  const sc = item.meta?.serviceCall;

  const inputBindings: Array<{ fieldCode: string; bindingVariable: string }> = [];
  if (sc?.inputState) {
    for (const input of sc.inputState) {
      if (input.fieldCode) {
        inputBindings.push({
          fieldCode: input.fieldCode,
          bindingVariable: input.bindingVariable ?? String(input.value ?? ""),
        });
      }
    }
  }

  const successMappings: Array<{ variable: string; expression: string }> = [];
  if (item.handler?.success) {
    for (const entry of item.handler.success) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const varMatch = (entry[0] as string).match(/\{%([^%]+)%\}/);
        successMappings.push({
          variable: varMatch?.[1] ?? (entry[0] as string),
          expression: entry[1] as string,
        });
      }
    }
  }

  const eventMeta = sc?.eventMeta ?? null;

  return {
    index,
    label: sc?.label ?? "(unnamed)",
    adId: item.request?.url ? cleanAdId(item.request.url) : null,
    serviceUuid: sc?.serviceUuid ?? null,
    method: item.request?.method ?? null,
    url: item.request?.url ?? null,
    triggers: (item.trigger ?? []).map((t) => t.replace(/^this\./, "")),
    triggerFilter: item.triggerFilter ?? null,
    inputBindings,
    successMappings,
    errorHandler: item.handler?.error ?? [],
    inProgressVar: item.handler?.inProgress?.match(/\{%([^%]+)%\}/)?.[1] ?? null,
    responseTransformSpec: item.responseTransformSpec ?? null,
    hasEventMeta: eventMeta !== null,
    eventMetaEmpty: eventMeta !== null && Object.keys(eventMeta).length === 0,
    eventMeta,
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

function findBindingLocations(configStr: string, varName: string): string[] {
  const locations: string[] = [];
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (configStr.includes(`"this.${varName}"`)) locations.push("http-trigger");
  if (new RegExp(`\\{%${escaped}%\\}`).test(configStr)) locations.push("binding");
  if (configStr.includes(`"{%${varName}%}"`)) locations.push("http-handler");
  const config = parseConfig(configStr);
  if (config) {
    for (const item of getHttpItems(config)) {
      if (item.handler?.inProgress?.includes(`{%${varName}%}`)) {
        locations.push("http-inProgress");
        break;
      }
    }
  }
  return locations;
}

export function extractVarDetail(configStr: string, varName: string): VarDetail | null {
  const vars = extractVariables(configStr);
  const ud = vars.userDefined.find((v) => v.name === varName);
  if (ud) {
    return {
      kind: "user-defined",
      name: ud.name,
      type: ud.type,
      initialValue: ud.initialValue,
      from: null,
      spec: null,
      filterFn: null,
      sideEffect: null,
      bindingReferences: findBindingLocations(configStr, varName),
    };
  }
  const d = vars.derived.find((v) => v.name === varName);
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
      bindingReferences: findBindingLocations(configStr, varName),
    };
  }
  return null;
}

// validateConfig retained for the existing `validate` command — will be
// replaced by a delegating shim to validateHydrated() in the same phase.
import type { ValidationIssue as LegacyValidationIssue } from "../types/legacy";

export function validateConfig(configStr: string): LegacyValidationIssue[] {
  const issues: LegacyValidationIssue[] = [];
  const config = parseConfig(configStr);
  if (!config) {
    return [{ code: "INVALID_JSON", severity: "error", message: "Configuration is not valid JSON" }];
  }

  const vars = extractVariables(configStr);
  const allDefinedVarNames = new Set<string>([
    ...vars.userDefined.map((v) => v.name),
    ...vars.derived.map((d) => d.name),
  ]);

  const bindingRefs = extractBindingReferences(configStr);
  const httpSummary = extractHttpSummary(configStr);

  for (const ref of bindingRefs) {
    if (!allDefinedVarNames.has(ref) && ref !== "null" && !ref.startsWith("$item")) {
      issues.push({
        code: "ORPHAN_BINDING",
        severity: "error",
        message: `Binding {%${ref}%} used but variable "${ref}" is not defined`,
      });
    }
  }

  const bindingRefSet = new Set(bindingRefs);
  for (const name of allDefinedVarNames) {
    if (name.startsWith("__") || name.startsWith("$$")) continue;
    if (!bindingRefSet.has(name) && !configStr.includes(`this.${name}`)) {
      issues.push({
        code: "UNUSED_VARIABLE",
        severity: "warn",
        message: `Variable "${name}" is defined but never referenced`,
      });
    }
  }

  const walkForValidation = (node: RawLayoutNode | undefined) => {
    if (!node) return;
    const nodeName = node.name ?? "unnamed";
    const nodeId = node.id ?? node._elementId ?? "unknown";

    if (nodeName === "exp-form-field" && node.props && !node.field) {
      issues.push({ code: "FORM_FIELD_PROPS", severity: "error", message: `"${nodeName}" at ${nodeId} uses "props" instead of "field" — causes silent page crash`, nodeId, nodeName });
    }
    if (node.children && !Array.isArray(node.children) && typeof node.children === "object") {
      issues.push({ code: "CHILDREN_NOT_ARRAY", severity: "error", message: `Node "${nodeName}" at ${nodeId} has children as object instead of array — renders empty`, nodeId, nodeName });
    }
    if (nodeName === "exp-data-table") {
      const hasDatasource = node.props?.["datasourceState"] || node.props?.["[datasourceState]"];
      if (!hasDatasource) {
        issues.push({ code: "TABLE_NO_DATASOURCE", severity: "warn", message: `"${nodeName}" at ${nodeId} is missing datasourceState binding`, nodeId, nodeName });
      }
      if (node.props?.["[columns]"] && node.props?.["initialValue"]) {
        issues.push({ code: "DYNAMIC_COLS_INITIAL", severity: "warn", message: `"${nodeName}" at ${nodeId} has dynamic [columns] with initialValue — may crash`, nodeId, nodeName });
      }
    }
    if (nodeName === "mat-slide-toggle") {
      issues.push({ code: "INVALID_SLIDE_TOGGLE", severity: "error", message: `"${nodeName}" at ${nodeId} has no runtime declaration — use exp-slide-toggle`, nodeId, nodeName });
    }
    if (nodeName === "mat-expansion-panel-header") {
      issues.push({ code: "INVALID_EXPANSION_HEADER", severity: "error", message: `"${nodeName}" at ${nodeId} is not a valid PD component`, nodeId, nodeName });
    }
    getLayoutChildren(node).forEach(walkForValidation);
  };
  walkForValidation(config.layout);

  for (const call of httpSummary) {
    for (const trigger of call.triggers) {
      if (trigger === "onInit" && !allDefinedVarNames.has("onInit")) {
        issues.push({ code: "MISSING_ONINIT_VAR", severity: "warn", message: `HTTP call "${call.label}" triggers on "onInit" but no onInit variable is defined` });
      }
    }
    if (call.eventMetaEmpty) {
      issues.push({ code: "EMPTY_EVENT_META", severity: "warn", message: `HTTP call "${call.label}" has empty eventMeta — may show "undefined - undefined" in UI` });
    }
  }

  return issues;
}
