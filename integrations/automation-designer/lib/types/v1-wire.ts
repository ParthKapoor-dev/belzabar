// Raw V1 Automation Designer API shapes. Only the parser, the V1 API client,
// and the V1 serializer should import from this file. Everything else imports
// from ./common.ts.

export interface V1RawMethodResponse {
  id?: number;
  uuid: string;
  referenceId: string;
  aliasName: string;
  automationState: "PUBLISHED" | "DRAFT";
  /** Stringified JSON — must be JSON.parse'd to see the real method body. */
  jsonDefinition: string;
  createdOn?: number;
  lastUpdatedOn?: number;
  lastUpdatedBy?: string;
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
  automationId?: string;
  automationApiId?: number;
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
  id: string;
  label: string;
  encodingType?: string;
  optional?: boolean;
  orderIndex?: number;
  showOnSDUi?: boolean;
  automationUserInputs?: V1AutomationUserInput[];
  [extra: string]: unknown;
}

export interface V1AutomationAPIOutput {
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
    label: string;
    serviceChainUID?: string;
    automationSystem: { label: string; remote?: boolean };
    automationUserInputs?: V1AutomationUserInput[];
    automationAPIOutputs?: V1AutomationAPIOutput[];
  };
  automationAuth?: { nickname: string };
  [extra: string]: unknown;
}

// ─── V1 save payload (what `POST /rest/api/automation/chain` expects) ────

export interface V1SavePayload {
  /** Stringified JSON of the inner definition. */
  jsonDefinition: string;
  category: { id: number; name: string };
  methodDeprecated?: boolean;
  version?: number;
  id?: number;
  uuid?: string;
}
