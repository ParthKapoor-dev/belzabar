// Version-neutral in-memory representation of an Automation Designer method.
//
// Both the V1 parser (lib/parser/v1.ts) and the V2 parser (lib/parser/v2.ts)
// produce instances of this shape. Commands and presenters must import from
// this file ONLY — never from v1-wire.ts or v2-wire.ts. The sourceVersion
// field lets serializers know which wire to emit back.
//
// Adding a field: if it is present on both V1 and V2 (possibly under
// different names) put it here with the most descriptive name and map into
// it from each parser. If it is wire-specific, keep the raw JSON in
// `raw`/`raw` sub-fields and add a view-only helper in a parser file.

/** The AD wire format a method was read from. */
export type ApiVersion = "v1" | "v2";

/**
 * `UNKNOWN` means the wire carried neither `automationState` nor `state`.
 * Write paths must treat it as unsafe (the draft guard refuses it).
 */
export type MethodState = "DRAFT" | "PUBLISHED" | "UNKNOWN";

type DataType =
  | "STRING"
  | "TEXT"
  | "NUMBER"
  | "INTEGER"
  | "FLOAT"
  | "BOOLEAN"
  | "DATE"
  | "TIMESTAMP"
  | "JSON"
  | "ARRAY"
  | "OBJECT"
  | "FILE"
  | "MAP"
  | "LINK";

// Lenient type alias so we keep strings the server sometimes sends (e.g.
// TEXT variants) but still get autocomplete for the common set.
type LooseDataType = DataType | (string & {});

/**
 * Unified method-level field (input / variable / output contract).
 * V1 fieldCode → code, V1 label → displayName. V2 key → code, V2 name →
 * displayName. V2-only fields (`reference`, `encodingType`) are optional.
 */
export interface MethodField {
  code: string;
  displayName?: string;
  type: LooseDataType;
  required?: boolean;
  description?: string;
  defaultValue?: string;
  /** V1 inputs carry this; V2 does not. belz uses it on the V1 test path. */
  testValue?: unknown;
  secured?: boolean;
  /** V1 internal-variable flag: excluded from the method's input contract. */
  hideInput?: boolean;
  orderIndex?: number;
  /** V2 only — wires this field to another step's output. */
  reference?: string;
  encodingType?: string;
  properties?: unknown[];
  /** Original wire JSON for this field — required for round-trip saves. */
  raw: unknown;
}

export interface MethodOutput {
  code: string;
  displayName?: string;
  type?: LooseDataType;
  description?: string;
  /** V1 numeric ID linking this output to a service's output definition. */
  automationAPIOutputId?: number;
  /** V2 UUID equivalent of automationAPIOutputId. */
  automationAPIOutputUuid?: string;
  /** V1 shared-variable wiring on a step output. */
  internalVarRef?: string;
  /** V2 equivalent of internalVarRef (on method-level outputs). */
  inputReference?: string;
  rawResponseContainer?: boolean;
  raw: unknown;
}

// ─── Step parsing ─────────────────────────────────────────────────────────

/**
 * A single input (mapping) supplied to a step. Works for both V1 (mapping
 * tree with automationUserInputId) and V2 (flat inputs with `key`).
 */
export interface StepInput {
  /** V2 only — input identifier. */
  key?: string;
  /** V2 `name` — the service's label for this input. */
  label?: string;
  /** V1 — numeric ID of the target parameter. */
  automationUserInputId?: number;
  /** UUID form (populated by V1 and V2). */
  automationUserInputUuid?: string;
  value: string | null;
  combineInput?: boolean;
  uiRepresentation?: string;
  encodingType?: string;
  securedInput?: boolean;
  /** V2 — wires this input to another step's output. */
  reference?: string;
  /** V1 nested OBJECT mappings. */
  mappings?: StepInput[];
  raw?: unknown;
}

/** One V1 basic-mode condition row. `groupOp` joins it to the previous row. */
export interface ConditionRow {
  field: string;
  operator: string;
  value: string | null;
  groupOp?: string;
}

interface BaseStep {
  orderIndex: number;
  description?: string;
  /** V1 — stable per-step ID assigned server-side. */
  automationId?: string;
  /** V1 numeric / V2 UUID identifying the target service API. */
  automationApiId?: number | string;
  /** Trimmed automationAPI uuid when known (V1 fat steps, V2, or the definition). */
  automationApiUuid?: string;
  /**
   * Service identity: automation-system name (`db_service`) and API
   * label (`data.read`). V2 carries them on the wire; V1 gets them from the
   * definition lookup (lib/hydrator.ts) or the verified per-env fast path.
   * Undefined when the service could not be resolved.
   */
  serviceName?: string;
  methodName?: string;
  runAsync?: boolean;
  streamCapable?: boolean;
  /** The step loops. V1: `repeatStepExecution`; V2: a `properties.repeatStepExecution` object with a type/value. */
  repeatStepExecution?: boolean;
  /** What the loop runs over: V1 `loopExecutionSource`; V2 `value` (or `start..end` for a range). */
  loopExecutionSource?: string;
  /** Loop type (`LOOP_EXECUTION_ON_*`), counter variable, parallelism. */
  loopConfiguration?: { executeParallel?: boolean; type?: string; counter?: string; numberOfConcurrentThread?: number };
  /** V1 advanced condition mode ("advance" / "basic"). */
  conditionMode?: "advance" | "basic";
  conditionExpression?: string;
  conditionConfiguration?: unknown;
  /** V1 basic-mode rows (`condition[]`); the expression is `conditionExpression`. */
  conditionRows?: ConditionRow[];
  forceExitFromFailure?: boolean;
  forceExitErrorMessage?: string;
  /** HTTP status the step exits with (V1 `forceExitStatusCode`, V2 `exitOnFailure.code`). */
  forceExitStatusCode?: number | string;
  /**
   * Conditional exit ("force return"): when this expression is true the method
   * returns right after the step. V1 `forceReturnConditionExpression` (+ mode and
   * basic rows `forceReturnCondition[]`; V1 shares the exit's status code and
   * message), V2 `properties.exitCondition.conditionalExit`.
   */
  forceReturnExpression?: string;
  forceReturnMode?: "advance" | "basic";
  forceReturnRows?: ConditionRow[];
  forceReturnStatusCode?: number | string;
  forceReturnMessage?: string;
  /** Account the step runs with. V1 `automationAuthId` + `accountName`, V2 `accountConfiguration {id, name}`. */
  account?: { id?: number | string; name?: string };
  outputs: MethodOutput[];
  inputs: StepInput[];
  /** Original wire JSON of this step — mandatory for round-trip saves. */
  raw: unknown;
}

export interface CustomCodeStep extends BaseStep {
  kind: "CUSTOM_CODE";
  language: "JAVASCRIPT" | "PYTHON" | "JAVA" | "COBOL" | "PERL" | null;
  customCodeEnv?: string;
  /** Decoded source (V1 base64-decoded; V2 inline). */
  source: string;
  /** How the source is stored on the wire. The serializer uses this to know
   *  whether to base64-encode on save. */
  sourceEncoding: "BASE_64" | "NONE";
}

export interface SpelEchoStep extends BaseStep {
  kind: "SPEL_ECHO";
  expression: string | null;
}

export interface SqlStep extends BaseStep {
  kind: "SQL";
  operation: "read" | "update" | "add" | "delete" | "schema.modify" | string;
  /** Decoded SQL string. */
  sql: string;
  sqlEncoding: "BASE_64" | "NONE";
  /** V1: uuid of the mapping that holds the query, so the serializer writes the same slot. */
  sqlInputUuid?: string;
  resultShape?: "OBJECT" | "ARRAY" | string;
  automationAuthId?: number;
  testAccountId?: number;
}

export interface RedisStep extends BaseStep {
  kind: "REDIS_GET" | "REDIS_SET" | "REDIS_REMOVE";
  key?: string;
  value?: string;
  ttlSeconds?: string;
  store?: string;
  overwrite?: string;
}

export interface ExistingServiceStep extends BaseStep {
  kind: "EXISTING_SERVICE";
}

export interface UnknownStep extends BaseStep {
  kind: "UNKNOWN";
  reason: string;
}

export type ParsedStep =
  | CustomCodeStep
  | SpelEchoStep
  | SqlStep
  | RedisStep
  | ExistingServiceStep
  | UnknownStep;

// ─── Method ──────────────────────────────────────────────────────────────

interface MethodCategory {
  id?: number;
  uuid?: string;
  name: string;
}

export interface HydratedMethod {
  /** Which wire format produced this HydratedMethod. Used by serialize/*. */
  sourceVersion: ApiVersion;

  // Identity
  uuid: string;
  /** V1 numeric chain-definition id. Keys the changelog endpoint. */
  numericId?: number;
  referenceId: string | null;
  state: MethodState;
  /** V1 only — short display alias. */
  aliasName?: string;
  version: number;

  // Display
  name: string;
  summary: string;
  description?: string;
  buttonLabel?: string;
  internalMethod?: boolean;
  /** `methodDeprecated` on both wires. */
  deprecated?: boolean;
  /** Who may call it: V1 `scope`, V2 `permissions.methodScope` (e.g. UNRESTRICTED). */
  scope?: string;
  /** Run-time limit: V2 `metadata.executionTimeLimit.timeoutInSecond`. */
  timeoutSeconds?: number;

  category: MethodCategory | null;

  // Contract
  inputs: MethodField[];
  variables: MethodField[];
  outputs: MethodOutput[];
  parsedSteps: ParsedStep[];
  assertions: unknown[];
  securityFields: unknown[];

  // Timestamps
  fetchedAt: number;
  createdOn?: number;
  updatedOn?: number;
  /** User id (the wire sends a number) as a string. */
  updatedBy?: string;

  // Round-trip
  /** Full wire body. V1: RawMethodResponse. V2: V2MethodResponse. */
  raw: unknown;
  /** Best-effort warnings captured during parse. Surfaced in --llm envelopes. */
  parseWarnings: string[];
  /**
   * V1 only: automationIds whose service definition lookup failed, so their
   * steps may be misclassified. A parse with any is never cached.
   */
  unresolvedServices?: string[];
}
