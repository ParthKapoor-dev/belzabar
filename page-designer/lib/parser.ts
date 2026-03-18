import type {
  InternalConfig,
  LayoutNode,
  HttpRequestItem,
  HttpCallSummary,
  NormalizedVariable,
  NormalizedDerived,
  EventHandlerInfo,
  ComponentTreeNode,
  ValidationIssue,
} from "./types";

/**
 * PARSER SERVICE
 */

export function cleanAdId(url: string): string | null {
  const pattern = /\/rest\/api\/automation\/chain\/execute\/([a-zA-Z0-9]+)/;
  const match = url.match(pattern);
  return match ? match[1] : null;
}

// --- Internal helpers ---

function parseConfig(configStr: string): InternalConfig | null {
  try {
    return JSON.parse(configStr);
  } catch {
    return null;
  }
}

function getHttpItems(config: InternalConfig): HttpRequestItem[] {
  return [
    ...(config.httpRequests?.userDefined ?? []),
    ...(config.http ?? []),
  ];
}

function getLayoutChildren(node: LayoutNode): LayoutNode[] {
  if (!node.children) return [];
  if (Array.isArray(node.children)) return node.children;
  return Object.values(node.children);
}

// --- Core extraction (existing, fixed for dual format) ---

export function extractReferences(configStr: string, whitelist: Set<string>) {
  const adIds = new Set<string>();
  const componentNames = new Set<string>();

  const config = parseConfig(configStr);
  if (!config) return { adIds: [], componentNames: [] };

  getHttpItems(config).forEach(item => {
    const url = item.request?.url;
    if (url) {
      const id = cleanAdId(url);
      if (id) adIds.add(id);
    }
  });

  const traverse = (node?: LayoutNode) => {
    if (!node) return;
    if (node.name && whitelist.has(node.name)) {
      componentNames.add(node.name);
    }
    getLayoutChildren(node).forEach(traverse);
  };
  traverse(config.layout);

  return {
    adIds: Array.from(adIds),
    componentNames: Array.from(componentNames),
  };
}

export function extractDirectChildComponentNames(configStr: string): string[] {
  const config = parseConfig(configStr);
  if (!config) return [];

  const names: string[] = [];
  const seen = new Set<string>();

  const walk = (node: LayoutNode | undefined) => {
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

// --- Variable extraction (dual-format aware) ---

export function extractVariables(configStr: string): {
  userDefined: NormalizedVariable[];
  derived: NormalizedDerived[];
} {
  const config = parseConfig(configStr);
  if (!config) return { userDefined: [], derived: [] };

  const userDefined: NormalizedVariable[] = [];

  // New format: variables.userDefined = [{name, type, initialValue, ...}]
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
  }
  // Old format: context.properties = [[name, value], ...]
  else if (config.context?.properties) {
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
  const derived: NormalizedDerived[] = rawDerived.map(d => ({
    name: d.name,
    from: d.from ?? [],
    spec: d.spec ?? null,
    filterFn: d.filterFn ?? null,
    sideEffect: d.sideEffect === true,
  }));

  return { userDefined, derived };
}

// --- HTTP extraction ---

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
          if (varMatch) outputBindings.push(varMatch[1]);
        }
      }
    }

    const triggers = (item.trigger ?? []).map(t => t.replace(/^this\./, ""));
    const eventMeta = sc?.eventMeta;

    return {
      index: idx + 1,
      label: sc?.label ?? "(unnamed)",
      adId: url ? cleanAdId(url) : null,
      serviceUuid: sc?.serviceUuid ?? null,
      triggers,
      hasEventMeta: eventMeta !== undefined,
      eventMetaEmpty: eventMeta !== undefined && Object.keys(eventMeta!).length === 0,
      outputBindings,
      inProgressVar: item.handler?.inProgress?.match(/\{%([^%]+)%\}/)?.[1] ?? null,
      method: item.request?.method ?? null,
    };
  });
}

// --- Binding references (regex scan) ---

export function extractBindingReferences(configStr: string): string[] {
  const seen = new Set<string>();
  const regex = /\{%([^%]+)%\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(configStr)) !== null) {
    seen.add(match[1]);
  }
  return Array.from(seen);
}

// --- Event handlers ---

export function extractEventHandlers(configStr: string): EventHandlerInfo[] {
  const config = parseConfig(configStr);
  if (!config) return [];

  const results: EventHandlerInfo[] = [];
  const walk = (node: LayoutNode | undefined) => {
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

// --- Component tree ---

export function extractComponentTree(configStr: string): ComponentTreeNode | null {
  const config = parseConfig(configStr);
  if (!config?.layout) return null;

  const buildNode = (node: LayoutNode): ComponentTreeNode => {
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

// --- Full HTTP detail for --http-detail ---

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
  const item = items[index - 1]; // 1-indexed
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
          variable: varMatch ? varMatch[1] : entry[0] as string,
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
    triggers: (item.trigger ?? []).map(t => t.replace(/^this\./, "")),
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

// --- Variable detail for --var-detail ---

export interface VarDetail {
  kind: "user-defined" | "derived";
  name: string;
  type: string | null;
  initialValue: unknown;
  // derived-specific
  from: string[] | null;
  spec: string | null;
  filterFn: string | null;
  sideEffect: boolean | null;
  // usage
  bindingReferences: string[]; // locations where {%name%} appears
}

export function extractVarDetail(configStr: string, varName: string): VarDetail | null {
  const vars = extractVariables(configStr);

  const ud = vars.userDefined.find(v => v.name === varName);
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

  const d = vars.derived.find(v => v.name === varName);
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

function findBindingLocations(configStr: string, varName: string): string[] {
  const locations: string[] = [];
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Check in HTTP triggers
  if (configStr.includes(`"this.${varName}"`)) locations.push("http-trigger");

  // Check in binding references
  if (new RegExp(`\\{%${escaped}%\\}`).test(configStr)) locations.push("binding");

  // Check in handler success/error
  if (configStr.includes(`"{%${varName}%}"`)) locations.push("http-handler");

  // Check in handler.inProgress
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

// --- Validation ---

export function validateConfig(configStr: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const config = parseConfig(configStr);
  if (!config) {
    return [{ code: "INVALID_JSON", severity: "error", message: "Configuration is not valid JSON" }];
  }

  const vars = extractVariables(configStr);
  const allDefinedVarNames = new Set([
    ...vars.userDefined.map(v => v.name),
    ...vars.derived.map(d => d.name),
  ]);

  const bindingRefs = extractBindingReferences(configStr);
  const httpSummary = extractHttpSummary(configStr);

  // 1. ORPHAN_BINDING
  for (const ref of bindingRefs) {
    if (!allDefinedVarNames.has(ref) && ref !== "null" && !ref.startsWith("$item")) {
      issues.push({
        code: "ORPHAN_BINDING",
        severity: "error",
        message: `Binding {%${ref}%} used but variable "${ref}" is not defined`,
      });
    }
  }

  // 2. UNUSED_VARIABLE
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

  // Layout tree checks
  const walkForValidation = (node: LayoutNode | undefined) => {
    if (!node) return;
    const nodeName = node.name ?? "unnamed";
    const nodeId = node.id ?? node._elementId ?? "unknown";

    // 3. FORM_FIELD_PROPS
    if (nodeName === "exp-form-field" && node.props && !node.field) {
      issues.push({
        code: "FORM_FIELD_PROPS",
        severity: "error",
        message: `"${nodeName}" at ${nodeId} uses "props" instead of "field" — causes silent page crash`,
        nodeId, nodeName,
      });
    }

    // 4. CHILDREN_NOT_ARRAY
    if (node.children && !Array.isArray(node.children) && typeof node.children === "object") {
      issues.push({
        code: "CHILDREN_NOT_ARRAY",
        severity: "error",
        message: `Node "${nodeName}" at ${nodeId} has children as object instead of array — renders empty`,
        nodeId, nodeName,
      });
    }

    // 5. TABLE_NO_DATASOURCE
    if (nodeName === "exp-data-table") {
      const hasDatasource = node.props?.["datasourceState"] || node.props?.["[datasourceState]"];
      if (!hasDatasource) {
        issues.push({
          code: "TABLE_NO_DATASOURCE",
          severity: "warn",
          message: `"${nodeName}" at ${nodeId} is missing datasourceState binding`,
          nodeId, nodeName,
        });
      }

      // 10. DYNAMIC_COLS_INITIAL
      if (node.props?.["[columns]"] && node.props?.["initialValue"]) {
        issues.push({
          code: "DYNAMIC_COLS_INITIAL",
          severity: "warn",
          message: `"${nodeName}" at ${nodeId} has dynamic [columns] with initialValue — may crash`,
          nodeId, nodeName,
        });
      }
    }

    // 6. INVALID_SLIDE_TOGGLE
    if (nodeName === "mat-slide-toggle") {
      issues.push({
        code: "INVALID_SLIDE_TOGGLE",
        severity: "error",
        message: `"${nodeName}" at ${nodeId} has no runtime declaration — use exp-slide-toggle`,
        nodeId, nodeName,
      });
    }

    // 7. INVALID_EXPANSION_HEADER
    if (nodeName === "mat-expansion-panel-header") {
      issues.push({
        code: "INVALID_EXPANSION_HEADER",
        severity: "error",
        message: `"${nodeName}" at ${nodeId} is not a valid PD component`,
        nodeId, nodeName,
      });
    }

    getLayoutChildren(node).forEach(walkForValidation);
  };
  walkForValidation(config.layout);

  // 8. MISSING_ONINIT_VAR
  for (const call of httpSummary) {
    for (const trigger of call.triggers) {
      if (trigger === "onInit" && !allDefinedVarNames.has("onInit")) {
        issues.push({
          code: "MISSING_ONINIT_VAR",
          severity: "warn",
          message: `HTTP call "${call.label}" triggers on "onInit" but no onInit variable is defined`,
        });
      }
    }

    // 9. EMPTY_EVENT_META
    if (call.eventMetaEmpty) {
      issues.push({
        code: "EMPTY_EVENT_META",
        severity: "warn",
        message: `HTTP call "${call.label}" has empty eventMeta — may show "undefined - undefined" in UI`,
      });
    }
  }

  return issues;
}
