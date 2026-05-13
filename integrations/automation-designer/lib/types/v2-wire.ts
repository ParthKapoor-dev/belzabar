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

export interface V2AccountConfiguration {
  id: string | number | null;
  name: string | null;
}

export interface V2EntryCondition {
  expression: string | null;
  expandedExpressions?: unknown | null;
}

export interface V2ExitCondition {
  exitOnFailure: { value: boolean; code: string | null; message: string };
  conditionalExit: {
    code: string | null;
    message: string;
    expression: string | null;
    expandedExpressions?: unknown | null;
  };
}

export interface V2CustomCodeProperties {
  inlineCode: string | null;
  language: "JAVASCRIPT" | "PYTHON" | "JAVA" | "COBOL" | "PERL" | null;
  executor: string | null;
}

export interface V2StepProperties {
  type: "EXISTING_SERVICE" | "CUSTOM_CODE";
  runAsync?: boolean;
  entryCondition?: V2EntryCondition;
  exitCondition?: V2ExitCondition;
  repeatStepExecution?: {
    enabled?: boolean;
    source?: string;
    executeParallel?: boolean;
    [extra: string]: unknown;
  };
  customCode?: V2CustomCodeProperties;
}

export interface V2StepInput {
  key: string;
  value: string | null;
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

export interface V2Metadata {
  id?: string | number;
  uuid: string;
  referenceId?: string | null;
  state: "DRAFT" | "PUBLISHED";
  version?: { name: string; id?: unknown };
  service?: { id: number; uuid: string; name: string };
  executionTimeLimit?: { timeoutInSecond: number };
  createdOn?: number;
  lastUpdatedOn?: number;
  lastUpdatedBy?: string;
  [extra: string]: unknown;
}

export interface V2MethodResponse {
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
