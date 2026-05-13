// Layout-tree walker → discriminated ParsedNode[].
//
// The walker has NO side effects beyond accumulating `parseWarnings`. It never
// mutates `raw` and it preserves it on every node so the serializer can
// round-trip unknown shapes verbatim.
//
// Kind detection (in order):
//   1. `isSymbol: true`         → SYMBOL (referenced component)
//   2. name === "exp-form-field"→ FORM_FIELD
//   3. name === "exp-data-table"→ DATA_TABLE
//   4. name === "button"        → BUTTON
//   5. name === "div" with layout.type=="flex"|"grid" and no innerHTML → LAYOUT_CONTAINER
//   6. everything else          → GENERIC
//
// Note: the ordering matters. `SymbolNode` overrides any other discriminator
// because an author can build a symbol named "button" and the isSymbol flag
// wins.

import type {
  ButtonNode,
  DataTableNode,
  FormFieldNode,
  GenericNode,
  HydratedPage,
  LayoutContainerNode,
  ParsedNode,
  SymbolNode,
} from "../types/common";
import type { RawLayoutNode } from "../types/wire";

// Cache shared across walk() for variable-backed look-ahead (DYNAMIC_COLS_INITIAL).
interface WalkContext {
  variables: HydratedPage["variables"];
  seenIds: Map<string, number>; // node-id → count
  warnings: string[];
  usedSynthIds: number;
}

function childList(node: RawLayoutNode): RawLayoutNode[] {
  const raw = node.children;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // Object-keyed children are the CHILDREN_NOT_ARRAY failure mode. Walk them
  // anyway (so the rest of the tree still parses) but emit a warning.
  return Object.values(raw);
}

function deriveNodeId(raw: RawLayoutNode, ctx: WalkContext): string {
  if (typeof raw.id === "string" && raw.id.length > 0) return raw.id;
  if (typeof raw._elementId === "string" && raw._elementId.length > 0) return raw._elementId;
  const synth = `__synthetic_${ctx.usedSynthIds++}`;
  ctx.warnings.push(`node at depth without id: synthesized "${synth}"`);
  return synth;
}

function recordId(nodeId: string, ctx: WalkContext): void {
  ctx.seenIds.set(nodeId, (ctx.seenIds.get(nodeId) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Kind parsers — each returns a fully-formed ParsedNode of its kind.
// ---------------------------------------------------------------------------

function parseFormField(
  raw: RawLayoutNode,
  nodeId: string,
  children: ParsedNode[],
): FormFieldNode {
  const field = typeof raw.field === "object" && raw.field !== null ? raw.field : null;
  const props = typeof raw.props === "object" && raw.props !== null ? raw.props : {};
  const usesPropsInsteadOfField = field === null && Object.keys(props).length > 0;

  // fieldType lives on field.type for well-formed nodes; fall back to props.type
  // for malformed ones so the validator can still catch PHONE_FIELD_TYPE.
  const pickType = (): string | null => {
    if (field && typeof field.type === "string") return field.type;
    if (typeof props.type === "string") return props.type as string;
    return null;
  };

  const valueBinding: string | null = (() => {
    const source = (field ?? props) as Record<string, unknown>;
    const raw = source["[(value)]"];
    if (typeof raw !== "string") return null;
    const match = raw.match(/\{%([^%]+)%\}/);
    return match?.[1] ?? null;
  })();

  const validations = (() => {
    const v = (field ?? props) as Record<string, unknown>;
    const arr = v.validation;
    return Array.isArray(arr) ? arr : [];
  })();

  return {
    kind: "FORM_FIELD",
    nodeId,
    elementId: typeof raw._elementId === "string" ? raw._elementId : null,
    tagName: raw.name ?? "exp-form-field",
    props,
    events: (raw.events as Record<string, unknown>) ?? null,
    loop: typeof raw.loop === "string" ? raw.loop : null,
    children,
    field,
    fieldType: pickType(),
    valueBinding,
    validations,
    usesPropsInsteadOfField,
    raw,
  };
}

function parseDataTable(
  raw: RawLayoutNode,
  nodeId: string,
  children: ParsedNode[],
  ctx: WalkContext,
): DataTableNode {
  const props = (raw.props as Record<string, unknown>) ?? {};
  const staticState = typeof props.datasourceState === "string" ? (props.datasourceState as string) : null;
  const dynamicState = typeof props["[datasourceState]"] === "string" ? (props["[datasourceState]"] as string) : null;
  const datasourceState = staticState ?? (dynamicState ? `<binding:${dynamicState}>` : null);

  const hasDynamicColumns = typeof props["[columns]"] === "string";
  const columnsRaw = props.columns ?? props["[columns]"] ?? null;
  const rowDataRaw = props["[rowData]"];
  const rowDataBinding = (() => {
    if (typeof rowDataRaw !== "string") return null;
    const match = rowDataRaw.match(/\{%([^%]+)%\}/);
    return match?.[1] ?? null;
  })();

  let hasInitialValueOnColumnsVar = false;
  if (hasDynamicColumns) {
    const bind = props["[columns]"] as string;
    const match = bind.match(/\{%([^%]+)%\}/);
    const varName = match?.[1];
    if (varName) {
      const v = ctx.variables.find((x) => x.name === varName);
      if (v && v.initialValue !== null && v.initialValue !== undefined && v.initialValue !== "") {
        hasInitialValueOnColumnsVar = true;
      }
    }
  }

  return {
    kind: "DATA_TABLE",
    nodeId,
    elementId: typeof raw._elementId === "string" ? raw._elementId : null,
    tagName: raw.name ?? "exp-data-table",
    props,
    events: (raw.events as Record<string, unknown>) ?? null,
    loop: typeof raw.loop === "string" ? raw.loop : null,
    children,
    datasourceState,
    hasDynamicColumns,
    hasInitialValueOnColumnsVar,
    rowDataBinding,
    columnsRaw,
    raw,
  };
}

function parseButton(
  raw: RawLayoutNode,
  nodeId: string,
  children: ParsedNode[],
): ButtonNode {
  const props = (raw.props as Record<string, unknown>) ?? {};
  const innerHTML = typeof props.innerHTML === "string" ? (props.innerHTML as string) : null;
  const hasDynamicClassName = typeof props["[className]"] === "string";

  return {
    kind: "BUTTON",
    nodeId,
    elementId: typeof raw._elementId === "string" ? raw._elementId : null,
    tagName: raw.name ?? "button",
    props,
    events: (raw.events as Record<string, unknown>) ?? null,
    loop: typeof raw.loop === "string" ? raw.loop : null,
    children,
    innerHTML,
    hasDynamicClassName,
    raw,
  };
}

function parseSymbol(
  raw: RawLayoutNode,
  nodeId: string,
  children: ParsedNode[],
): SymbolNode {
  const props = (raw.props as Record<string, unknown>) ?? {};
  const inputBindings: Array<{ prop: string; binding: string }> = [];
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("[") && k.endsWith("]") && typeof v === "string") {
      inputBindings.push({ prop: k.slice(1, -1), binding: v });
    }
  }
  const events = (raw.events as Record<string, unknown>) ?? null;
  const eventWires = events ? Object.keys(events) : [];

  return {
    kind: "SYMBOL",
    nodeId,
    elementId: typeof raw._elementId === "string" ? raw._elementId : null,
    tagName: raw.name ?? "",
    props,
    events,
    loop: typeof raw.loop === "string" ? raw.loop : null,
    children,
    symbolName: typeof raw.name === "string" ? raw.name : "",
    inputBindings,
    eventWires,
    raw,
  };
}

function parseLayoutContainer(
  raw: RawLayoutNode,
  nodeId: string,
  children: ParsedNode[],
  isRoot: boolean,
): LayoutContainerNode {
  const props = (raw.props as Record<string, unknown>) ?? {};
  const layoutProps =
    props.layout && typeof props.layout === "object" ? (props.layout as Record<string, unknown>) : null;
  return {
    kind: "LAYOUT_CONTAINER",
    nodeId,
    elementId: typeof raw._elementId === "string" ? raw._elementId : null,
    tagName: raw.name ?? "div",
    props,
    events: (raw.events as Record<string, unknown>) ?? null,
    loop: typeof raw.loop === "string" ? raw.loop : null,
    children,
    layoutProps,
    isRoot,
    raw,
  };
}

function parseGeneric(
  raw: RawLayoutNode,
  nodeId: string,
  children: ParsedNode[],
): GenericNode {
  return {
    kind: "GENERIC",
    nodeId,
    elementId: typeof raw._elementId === "string" ? raw._elementId : null,
    tagName: raw.name ?? "",
    props: (raw.props as Record<string, unknown>) ?? {},
    events: (raw.events as Record<string, unknown>) ?? null,
    loop: typeof raw.loop === "string" ? raw.loop : null,
    children,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Main walker
// ---------------------------------------------------------------------------

function walk(raw: RawLayoutNode, ctx: WalkContext, isRoot: boolean): ParsedNode {
  const nodeId = deriveNodeId(raw, ctx);
  recordId(nodeId, ctx);

  // children-as-object detection (CHILDREN_NOT_ARRAY — validator will fire too)
  if (raw.children && !Array.isArray(raw.children) && typeof raw.children === "object") {
    ctx.warnings.push(`node "${nodeId}" (${raw.name ?? "?"}) has object-keyed children`);
  }

  const kids = childList(raw);
  const children = kids.map((k) => walk(k, ctx, false));

  if (raw.isSymbol === true) return parseSymbol(raw, nodeId, children);
  if (raw.name === "exp-form-field") return parseFormField(raw, nodeId, children);
  if (raw.name === "exp-data-table") return parseDataTable(raw, nodeId, children, ctx);
  if (raw.name === "button") return parseButton(raw, nodeId, children);

  if (raw.name === "div") {
    const props = (raw.props as Record<string, unknown>) ?? {};
    const hasLayout = typeof props.layout === "object" && props.layout !== null;
    const hasContent = typeof props.innerHTML === "string" && (props.innerHTML as string).length > 0;
    if (isRoot || (hasLayout && !hasContent)) {
      return parseLayoutContainer(raw, nodeId, children, isRoot);
    }
  }

  return parseGeneric(raw, nodeId, children);
}

export interface ParsedLayoutResult {
  root: ParsedNode;
  warnings: string[];
  duplicateIds: string[];
}

export function parseLayout(
  rawLayout: RawLayoutNode | undefined | null,
  variables: HydratedPage["variables"],
): ParsedLayoutResult {
  const ctx: WalkContext = {
    variables,
    seenIds: new Map(),
    warnings: [],
    usedSynthIds: 0,
  };

  if (!rawLayout || typeof rawLayout !== "object") {
    // Empty page — return a synthetic empty root so downstream walkers don't
    // null-check. Validator will flag ROOT_LAYOUT_MALFORMED.
    ctx.warnings.push("missing layout root");
    const empty: GenericNode = {
      kind: "GENERIC",
      nodeId: "__missing_root",
      elementId: null,
      tagName: "",
      props: {},
      events: null,
      loop: null,
      children: [],
      raw: rawLayout ?? null,
    };
    return { root: empty, warnings: ctx.warnings, duplicateIds: [] };
  }

  const root = walk(rawLayout, ctx, true);
  const duplicateIds: string[] = [];
  for (const [id, count] of ctx.seenIds.entries()) {
    if (count > 1) duplicateIds.push(id);
  }
  return { root, warnings: ctx.warnings, duplicateIds };
}

// ---------------------------------------------------------------------------
// Tree utilities (used by show + validator)
// ---------------------------------------------------------------------------

export function walkParsed(root: ParsedNode, visit: (node: ParsedNode) => void): void {
  visit(root);
  for (const child of root.children) walkParsed(child, visit);
}

export function findNode(root: ParsedNode, nodeId: string): ParsedNode | null {
  let found: ParsedNode | null = null;
  walkParsed(root, (n) => {
    if (!found && n.nodeId === nodeId) found = n;
  });
  return found;
}
