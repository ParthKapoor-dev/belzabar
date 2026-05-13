// Raw API shapes (wire types). These mirror what the PD REST API emits on the
// wire — nothing more, nothing less.
//
// Import rules: only lib/api/client.ts and lib/parser/** may import from this
// file. Commands and presenters import from ./common.ts exclusively. This
// separation is the whole point of splitting types — keep wire-level
// weirdness (stringified configuration, numeric versionIds, dual formats)
// away from every downstream consumer.

export type PdStatus = "DRAFT" | "PUBLISHED";
export type PdEntityType = "PAGE" | "COMPONENT";

// -------- GET /pages/{id} + GET /pages/version/{vid} ---------------------

export interface RawPageResponse {
  id: string;
  name: string;
  status?: PdStatus;
  versionId?: number;
  aliasName?: string;
  alias_name?: string;
  hostIds?: string;
  ownerId?: number;
  themes?: unknown;
  dynamicRoute?: string;
  relativeRoute?: string;
  authenticated?: boolean;
  createdAt?: number;
  createdBy?: number;
  updatedAt?: number;
  updatedBy?: number;
  // configuration is a STRINGIFIED JSON blob. Parse before consuming.
  configuration?: string;
  [key: string]: unknown;
}

// -------- GET /pages (list) ---------------------------------------------

export interface RawPageListItem {
  id?: unknown;
  name?: unknown;
  relativeRoute?: unknown;
  referenceId?: unknown;
  status?: unknown;
  versionId?: unknown;
  isSymbol?: unknown;
  isComponent?: unknown;
  layout?: { isSymbol?: unknown } | unknown;
  pageElement?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
  createdAt?: unknown;
  createdBy?: unknown;
  [key: string]: unknown;
}

// -------- GET /pages/history ---------------------------------------------

export interface RawHistoryEntry {
  id: number; // this IS the versionId — not the pageId
  pageId: string;
  status: PdStatus;
  partialUpdate: boolean;
  updatedAt: number;
  updatedBy: number;
  userName?: string;
  [key: string]: unknown;
}

// -------- PUT /pages/{id} partial-update operation ----------------------
//
// Shape: { key, value, operation, dataType }. Field is `key` (dot-notation
// path), NOT `path`. `value` is ALWAYS a string — numbers are stringified,
// booleans are stringified, objects/arrays are JSON.stringify'd. See
// docs/api-notes.md.

export type PartialOperation = "CREATE" | "UPDATE";
export type PartialDataType = "STRING" | "NUMBER" | "BOOLEAN" | "ARRAY" | "OBJECT";

export interface RawPartialUpdateOperation {
  key: string;
  value: string;
  operation: PartialOperation;
  dataType: PartialDataType;
}

// -------- Configuration body (parsed out of RawPageResponse.configuration)
//
// This is the "inner" shape of the stringified JSON. Used by the parser to
// produce the unified HydratedPage. Most of the detail lives inside
// `layout` (recursive node tree), `variables.*`, and `httpRequests.*`.

export interface RawLayoutNode {
  id?: string;
  name?: string;
  isSymbol?: boolean;
  unSelectable?: boolean;
  props?: Record<string, unknown>;
  field?: Record<string, unknown>; // only on exp-form-field
  events?: Record<string, unknown>;
  children?: RawLayoutNode[] | Record<string, RawLayoutNode>;
  loop?: string;
  _elementId?: string;
  __LAYOUT_CONFIG_METADATA?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RawUserDefinedVar {
  name: string;
  type?: string;
  initialValue?: unknown;
  translateInitialValue?: boolean;
  __LAYOUT_CONFIG_METADATA?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RawDerivedVar {
  name: string;
  from?: string[];
  spec?: string;
  filterFn?: string;
  sideEffect?: boolean;
  [key: string]: unknown;
}

export interface RawHttpRequestItem {
  meta?: {
    serviceCall?: {
      label?: string;
      callId?: string;
      serviceId?: number;
      serviceUuid?: string;
      eventMeta?: Record<string, unknown>;
      inputState?: Array<{
        fieldCode?: string;
        isBinding?: boolean;
        bindingVariable?: string;
        value?: unknown;
      }>;
    };
  };
  handler?: {
    error?: unknown[];
    success?: Array<[string, string] | string>;
    state?: string;
    inProgress?: string;
  };
  request?: {
    url?: string;
    body?: string;
    method?: string;
    headers?: Record<string, string>;
    isAuthorized?: boolean;
    responseType?: string;
    useExpressionCompiler?: boolean;
  };
  trigger?: string[];
  triggerFilter?: string;
  responseTransformSpec?: string;
  [key: string]: unknown;
}

export interface RawConfiguration {
  __version?: number;
  layout?: RawLayoutNode;
  styles?: string;
  variables?: {
    generated?: unknown[];
    userDefined?: RawUserDefinedVar[];
    derived?: RawDerivedVar[];
  };
  httpRequests?: {
    generated?: RawHttpRequestItem[];
    userDefined?: RawHttpRequestItem[];
  };
  // Symbol-only
  inputs?: string[];
  events?: string[];
  helpText?: Record<string, unknown>;
  // Legacy format (older pages)
  context?: {
    properties?: Array<[string, unknown]>;
    derived?: RawDerivedVar[];
  };
  http?: RawHttpRequestItem[];
  [key: string]: unknown;
}
