// Raw V1 Automation Designer API shapes. Only the parser, the V1 API client,
// and the V1 serializer should import from this file. Everything else imports
// from ./common.ts.

export interface V1RawMethodResponse {
  id?: number;
  uuid: string;
  referenceId: string;
  aliasName: string;
  automationState?: "PUBLISHED" | "DRAFT";
  /** The wire also carries `state` (same values). */
  state?: "PUBLISHED" | "DRAFT";
  /** Stringified JSON — must be JSON.parse'd to see the real method body. */
  jsonDefinition: string;
  createdOn?: number;
  /** Real wire: epoch ms + numeric user id. Absent on never-edited methods. */
  updatedOn?: number;
  updatedBy?: number | string;
  /** Legacy spelling kept for old captures. */
  lastUpdatedOn?: number;
  lastUpdatedBy?: string;
  deprecatedAt?: number | null;
  version?: number;
  category?: { id: number; name: string };
  owner?: { id: number; username: string };
  [extra: string]: unknown;
}

export interface V1InputField {
  fieldCode: string;
  label?: string;
  type: string;
  required?: boolean;
  description?: string;
  defaultValue?: string;
  testValue?: unknown;
  secured?: boolean;
  editable?: boolean;
  hideInput?: boolean;
  orderIndex?: number;
  properties?: unknown[];
  showOnSDUi?: boolean;
  inputVarRef?: string;
  [extra: string]: unknown;
}

export interface V1OutputField {
  id?: unknown;
  code: string;
  type?: string;
  fieldCode?: string;
  outputCode?: string;
  displayName?: string;
  properties?: unknown[];
  rawResponseContainer?: boolean;
  automationAPIOutputId?: number;
  hiddenAutomationAPIOutputIds?: unknown[];
  internalVarRef?: string;
  elementToRetrieve?: string;
  [extra: string]: unknown;
}

export interface V1Mapping {
  value?: string;
  mappings?: V1Mapping[];
  withPrefix?: boolean;
  securedInput?: boolean;
  combineInputs?: boolean;
  encodingType?: string;
  uiRepresentation?: string;
  requiresProcessing?: boolean;
  skipFileProcessing?: boolean;
  automationUserInputId?: number;
  automationUserInputUuid?: string;
  [extra: string]: unknown;
}

export interface V1ServiceStep {
  /** Numeric on the real wire. */
  automationId?: string;
  automationApiId?: number;
  /** "Fat" steps written by newer UIs carry the API uuid and the system name. */
  automationApiUuid?: string;
  categoryName?: string;
  orderIndex: number;
  description?: string;
  type?: string;
  activeTab?: { id?: string };
  code?: string;
  language?: string;
  customCodeEnv?: string;
  mappings?: V1Mapping[];
  outputs?: V1OutputField[];
  runAsync?: boolean;
  streamCapable?: boolean;
  repeatStepExecution?: boolean;
  loopExecutionSource?: string;
  loopConfiguration?: { executeParallel?: boolean; type?: string };
  conditionMode?: "advance" | "basic";
  conditionExpression?: string;
  conditionConfiguration?: unknown;
  condition?: unknown[];
  forceExitFromFailure?: boolean;
  forceExitErrorMessage?: string;
  /** HTTP status for both exit-on-failure and the conditional exit. */
  forceExitStatusCode?: number | string | null;
  automationAuthId?: number;
  testAccountId?: number;
  [extra: string]: unknown;
}

export interface V1InnerDefinition {
  name?: string;
  description?: string;
  methodDescription?: string;
  summary?: string;
  buttonLabel?: string;
  internalMethod?: boolean;
  inputs?: V1InputField[];
  variables?: V1InputField[];
  services?: V1ServiceStep[];
  outputs?: V1OutputField[];
  assertions?: unknown[];
  securityFields?: unknown[];
  [extra: string]: unknown;
}

// ─── Hydrator types (service catalog — shared between V1 and V2 in practice)

export interface V1AutomationUserInput {
  /** Numeric on the real wire. */
  id: string;
  uuid?: string;
  label: string;
  /** The input's key in the request (`queryString`, `body`, …). */
  produces?: string;
  encodingType?: string;
  optional?: boolean;
  orderIndex?: number;
  showOnSDUi?: boolean;
  automationUserInputs?: V1AutomationUserInput[];
  [extra: string]: unknown;
}

interface V1AutomationAPIOutput {
  id: string;
  displayName: string;
  showOnUi?: boolean;
  [extra: string]: unknown;
}

export interface V1AutomationDefinition {
  id: number;
  uuid: string;
  automationAPI: {
    id: number;
    uuid?: string;
    label: string;
    serviceChainUID?: string;
    /** `name` is what V2 calls `serviceName` (`db_service`); `label` may differ (`Database.SQL`). */
    automationSystem: { label: string; name?: string; uuid?: string; remote?: boolean };
    automationUserInputs?: V1AutomationUserInput[];
    automationAPIOutputs?: V1AutomationAPIOutput[];
  };
  automationAuth?: { nickname: string };
  [extra: string]: unknown;
}
