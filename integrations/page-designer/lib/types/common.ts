// Unified in-memory types for Page Designer.
//
// Every PD command imports types from THIS file only. Wire-level shapes
// (stringified configuration, raw handler arrays, etc.) live in wire.ts and
// must not leak into commands or presenters.
//
// Design invariants:
//   1. `raw` is preserved on every ParsedNode / PageVariable / PageHttpRequest
//      and on HydratedPage itself. Unknown shapes round-trip verbatim.
//   2. ParsedNode is a discriminated union keyed on `kind` — every walker uses
//      exhaustive switches.
//   3. The validator operates on HydratedPage; the serializer produces raw
//      shapes FROM HydratedPage. No command ever crosses the wire boundary.

import type { PdEntityType, PdStatus, RawPartialUpdateOperation } from "./wire";

export type { PdEntityType, PdStatus };

// ============================================================================
// Variables
// ============================================================================

export type PdDataType = "String" | "Boolean" | "Number" | "Any" | "KeyValue" | "PAGINATION_STORE" | string;

export interface PageVariable {
  name: string;
  type: PdDataType | null;
  initialValue: unknown;
  translateInitialValue?: boolean;
  raw: unknown; // original variable object (both formats)
}

export interface PageDerivedVariable {
  name: string;
  from: string[];
  spec: string | null;
  filterFn: string | null;
  sideEffect: boolean;
  raw: unknown;
}

// ============================================================================
// HTTP requests (service calls)
// ============================================================================

export interface PageHttpInputBinding {
  fieldCode: string;
  isBinding: boolean;
  bindingVariable: string | null;
  value: unknown;
}

export interface PageHttpSuccessMapping {
  variable: string; // stripped of {% %} wrappers
  expression: string;
}

export interface PageHttpRequest {
  index: number; // 1-based, stable order of appearance
  label: string;
  callId: string | null;
  serviceId: number | null;
  serviceUuid: string | null;
  adId: string | null;
  method: string | null;
  url: string | null;
  triggers: string[];
  triggerFilter: string | null;
  inputBindings: PageHttpInputBinding[];
  successMappings: PageHttpSuccessMapping[];
  errorHandler: unknown[];
  inProgressVar: string | null;
  responseTransformSpec: string | null;
  hasEventMeta: boolean;
  eventMetaEmpty: boolean;
  eventMeta: Record<string, unknown> | null;
  requestBody: string | null;
  source: "generated" | "userDefined" | "legacy"; // which bucket it came from
  raw: unknown;
}

// ============================================================================
// Parsed node (layout tree)
// ============================================================================

export type NodeKind =
  | "FORM_FIELD"
  | "DATA_TABLE"
  | "BUTTON"
  | "SYMBOL"
  | "LAYOUT_CONTAINER"
  | "GENERIC";

export interface BaseNode {
  nodeId: string; // node.id ?? _elementId ?? synthetic
  elementId: string | null;
  tagName: string; // original name from wire (exp-form-field, div, etc.)
  props: Record<string, unknown>;
  events: Record<string, unknown> | null;
  loop: string | null;
  children: ParsedNode[];
  raw: unknown;
}

export interface FormFieldNode extends BaseNode {
  kind: "FORM_FIELD";
  field: Record<string, unknown> | null;
  fieldType: string | null; // text, textarea, select, checkbox, phone, etc.
  valueBinding: string | null; // [(value)] binding variable name
  validations: unknown[];
  // When true, this form-field is wrongly using `props` instead of `field` —
  // the #1 silent-crash. Validator rule FORM_FIELD_PROPS consumes this.
  usesPropsInsteadOfField: boolean;
}

export interface DataTableNode extends BaseNode {
  kind: "DATA_TABLE";
  datasourceState: string | null;
  hasDynamicColumns: boolean; // [columns] binding present
  hasInitialValueOnColumnsVar: boolean; // companion check for DYNAMIC_COLS_INITIAL
  rowDataBinding: string | null;
  columnsRaw: unknown;
}

export interface ButtonNode extends BaseNode {
  kind: "BUTTON";
  innerHTML: string | null;
  hasDynamicClassName: boolean; // [className] binding — invisible render
}

export interface SymbolNode extends BaseNode {
  kind: "SYMBOL";
  symbolName: string; // node.name (the referenced component)
  inputBindings: Array<{ prop: string; binding: string }>;
  eventWires: string[]; // event names the parent has wired
}

export interface LayoutContainerNode extends BaseNode {
  kind: "LAYOUT_CONTAINER";
  layoutProps: Record<string, unknown> | null;
  isRoot: boolean;
}

export interface GenericNode extends BaseNode {
  kind: "GENERIC";
}

export type ParsedNode =
  | FormFieldNode
  | DataTableNode
  | ButtonNode
  | SymbolNode
  | LayoutContainerNode
  | GenericNode;

// ============================================================================
// Hydrated page (the shape every command sees)
// ============================================================================

export interface HydratedPage {
  // Identity
  id: string;
  name: string;
  entityType: PdEntityType;
  status: PdStatus;
  versionId: number | null;
  aliasName: string | null;

  // Top-level metadata
  __version: number | null;

  // Layout
  layout: ParsedNode;
  styles: string;

  // Contract
  variables: PageVariable[];
  derived: PageDerivedVariable[];
  httpRequests: PageHttpRequest[];

  // Symbol-only (empty arrays on pages)
  inputs: string[];
  events: string[];
  helpText: Record<string, unknown>;

  // Bookkeeping
  updatedAt: number | null;
  updatedBy: number | null;
  createdAt: number | null;
  createdBy: number | null;

  // Round-trip
  raw: unknown;                 // full wire body
  rawConfiguration: unknown;    // parsed (not stringified) inner config
  rawConfigurationString: string; // original stringified configuration
  parseWarnings: string[];
}

// ============================================================================
// Validation
// ============================================================================

export type ValidationSeverity = "error" | "warn";

export interface ValidationIssue {
  code: string;               // UPPER_SNAKE_CASE rule code — see docs/api-notes.md
  severity: ValidationSeverity;
  message: string;
  nodeId?: string | null;
  nodeName?: string | null;
  path?: string | null;       // dot-notation when applicable
}

// ============================================================================
// Overlay (the primary edit surface for `belz pd save`)
// ============================================================================

export interface VariableOverlay {
  add?: Array<{
    name: string;
    type?: PdDataType;
    initialValue?: unknown;
    translateInitialValue?: boolean;
  }>;
  update?: Array<{
    name: string;
    type?: PdDataType;
    initialValue?: unknown;
    translateInitialValue?: boolean;
  }>;
  remove?: string[];
}

export interface DerivedOverlay {
  add?: Array<{
    name: string;
    from: string[];
    spec: string;
    filterFn?: string;
    sideEffect?: boolean;
  }>;
  update?: Array<{
    name: string;
    from?: string[];
    spec?: string;
    filterFn?: string;
    sideEffect?: boolean;
  }>;
  remove?: string[];
}

export interface HttpOverlayEntry {
  callId: string;
  request?: Partial<{ url: string; body: string; method: string }>;
  handler?: Partial<{
    success: Array<[string, string] | string>;
    error: unknown[];
    inProgress: string;
  }>;
  trigger?: string[];
  triggerFilter?: string;
  responseTransformSpec?: string;
}

export interface HttpOverlay {
  add?: unknown[];            // raw http request bodies (pass-through; rarely used)
  update?: HttpOverlayEntry[];
  remove?: string[];          // callIds to remove
}

export interface ElementOperation {
  key: string;                 // dot-notation path
  operation: "CREATE" | "UPDATE";
  value: unknown;              // serializer stringifies per dataType
  dataType: "STRING" | "NUMBER" | "BOOLEAN" | "ARRAY" | "OBJECT";
}

export interface Overlay {
  variables?: VariableOverlay;
  derived?: DerivedOverlay;
  httpRequests?: HttpOverlay;
  elements?: { operations: ElementOperation[] };
  styles?: { replace: string };
}

// Re-export the wire operation type so the serializer can produce it without
// having to import wire.ts from two places.
export type { RawPartialUpdateOperation };
