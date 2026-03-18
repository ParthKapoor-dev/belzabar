/**
 * TYPES
 */

export interface PageConfigResponse {
  name: string;
  configuration: string; // Stringified JSON
  [key: string]: unknown;
}

export interface ComponentSearchItem {
  id: string;
  name: string;
  referenceId?: string;
  status?: string;
  isSymbol?: boolean;
  layout?: {
    isSymbol?: boolean;
  };
  [key: string]: unknown;
}

export interface HttpRequestItem {
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
  };
  trigger?: string[];
  triggerFilter?: string;
  responseTransformSpec?: string;
}

export interface DerivedVariable {
  name: string;
  from: string[];
  spec?: string;
  initial?: unknown;
  filterFn?: string;
  sideEffect?: boolean;
}

export interface LayoutNode {
  id?: string;
  name?: string;
  isSymbol?: boolean;
  props?: Record<string, unknown>;
  field?: Record<string, unknown>;
  events?: Record<string, unknown[]>;
  children?: LayoutNode[] | Record<string, LayoutNode>;
  _elementId?: string;
}

// New format: variables.userDefined is array of objects {name, type, initialValue, ...}
// Old format: context.properties is array of tuples [name, value]
export interface UserDefinedVarObject {
  name: string;
  type?: string;
  initialValue?: unknown;
  translateInitialValue?: boolean;
  __LAYOUT_CONFIG_METADATA?: Record<string, unknown>;
}

export interface InternalConfig {
  httpRequests?: { userDefined?: HttpRequestItem[] };
  http?: HttpRequestItem[];
  variables?: {
    generated?: unknown[];
    userDefined?: UserDefinedVarObject[];
    derived?: DerivedVariable[];
  };
  context?: {
    properties?: Array<[string, unknown]>;
    derived?: DerivedVariable[];
  };
  layout?: LayoutNode;
}

// Normalized variable (common shape from both formats)
export interface NormalizedVariable {
  name: string;
  type: string | null;
  initialValue: unknown;
}

export interface NormalizedDerived {
  name: string;
  from: string[];
  spec: string | null;
  filterFn: string | null;
  sideEffect: boolean;
}

export interface ReportNode {
  type: 'PAGE' | 'COMPONENT';
  name: string;
  id: string;
  adIds: string[];
  children: ReportNode[];
}

export interface RogueIdInfo {
  id: string;
  foundIn: string[];
}

export interface ComplianceResult {
  isCompliant: boolean;
  rogueIds: RogueIdInfo[];
  missingIds: string[];
  commonIds: string[];
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

export interface EventHandlerInfo {
  nodeId: string;
  nodeName: string;
  eventTypes: string[];
}

export interface ComponentTreeNode {
  name: string;
  id: string;
  isSymbol: boolean;
  hasEvents: boolean;
  childCount: number;
  children: ComponentTreeNode[];
}

export interface ValidationIssue {
  code: string;
  severity: "error" | "warn";
  message: string;
  nodeId?: string;
  nodeName?: string;
}
