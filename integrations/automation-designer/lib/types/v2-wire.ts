// Raw V2 Automation Designer API shapes. Only the V2 parser and V2 API client
// import from this file. Everything else imports from ./common.ts.

export interface V2Field {
  key: string;
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  defaultValue?: string;
  properties?: unknown[];
  reference?: string;
  encodingType?: "NONE" | "BASE_64" | string;
  secured?: boolean;
  [extra: string]: unknown;
}

export interface V2Output {
  key: string;
  name?: string;
  type?: string;
  description?: string;
  fieldCode?: string;
  inputReference?: string;
  rawResponseContainer?: boolean;
  [extra: string]: unknown;
}

interface V2AccountConfiguration {
  id: string | number | null;
  name: string | null;
}

interface V2EntryCondition {
  expression: string | null;
  expandedExpressions?: unknown | null;
}

interface V2ExitCondition {
  /** code: the HTTP status (an integer on the wire). */
  exitOnFailure: { value: boolean; code: number | string | null; message: string };
  conditionalExit: {
    code: number | string | null;
    message: string;
    expression: string | null;
    expandedExpressions?: unknown | null;
  };
}

interface V2CustomCodeProperties {
  inlineCode: string | null;
  language: "JAVASCRIPT" | "PYTHON" | "JAVA" | "COBOL" | "PERL" | null;
  executor: string | null;
}

export interface V2StepProperties {
  type: "EXISTING_SERVICE" | "CUSTOM_CODE";
  runAsync?: boolean;
  entryCondition?: V2EntryCondition;
  exitCondition?: V2ExitCondition;
  /**
   * Real wire: `{type, value, counter, executeParallel,
   * numberOfConcurrentThread}` (+ `rangeStartInclusive`/`rangeEndExclusive`
   * for LOOP_EXECUTION_ON_RANGE, `expandedExpression` for _ON_CONDITION).
   * `enabled`/`source` are an older wi-impl guess, still read for compatibility.
   */
  repeatStepExecution?: {
    type?: string | null;
    value?: string | null;
    counter?: string | null;
    executeParallel?: boolean | null;
    numberOfConcurrentThread?: number | null;
    rangeStartInclusive?: string | number | null;
    rangeEndExclusive?: string | number | null;
    enabled?: boolean;
    source?: string;
    [extra: string]: unknown;
  } | null;
  customCode?: V2CustomCodeProperties;
}

export interface V2StepInput {
  uuid?: string;
  key: string;
  name?: string;
  type?: string;
  displayWidgetSuggestion?: string;
  value?: string | null;
  combineInput?: boolean;
  properties?: unknown[];
  reference?: string;
  encodingType?: string;
  [extra: string]: unknown;
}

export interface V2Step {
  automationAPIId?: string;
  serviceName?: string;
  methodName?: string;
  description?: string;
  inputs?: V2StepInput[];
  outputs?: V2Output[];
  accountConfiguration?: V2AccountConfiguration;
  properties?: V2StepProperties;
  [extra: string]: unknown;
}

interface V2Metadata {
  id?: string | number;
  /** Not on the real wire — the uuid is `V2MethodResponse.uuid`. */
  uuid?: string;
  referenceId?: string | null;
  state: "DRAFT" | "PUBLISHED";
  version?: { name: string; id?: unknown; uuid?: string };
  service?: { id: number; uuid: string; name: string };
  executionTimeLimit?: { timeoutInSecond: number };
  createdOn?: number;
  updatedOn?: number;
  updatedBy?: number | string;
  lastUpdatedOn?: number;
  lastUpdatedBy?: string;
  internal?: { createdAt?: number; createdBy?: number; lastPublishedAt?: number | null; [extra: string]: unknown };
  [extra: string]: unknown;
}

export interface V2MethodResponse {
  /** The method uuid (top-level on the real wire). */
  uuid?: string;
  name?: string;
  summary?: string;
  description?: string;
  buttonLabel?: string;
  internalMethod?: boolean;
  metadata: V2Metadata;
  inputs?: V2Field[];
  variables?: V2Field[];
  outputs?: V2Output[];
  steps?: V2Step[];
  assertions?: unknown[];
  securityFields?: unknown[];
  [extra: string]: unknown;
}

/**
 * A V2 method body as sent to `POST /chain/v2` (the fetched GET body with
 * changes overlaid). The validator (lib/validate) takes this shape.
 */
export type V2MethodBody = V2MethodResponse;
