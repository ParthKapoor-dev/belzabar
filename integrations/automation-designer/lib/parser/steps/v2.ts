// Parse a single V2 step into a ParsedStep.
//
// V2 names each step's service on the wire (serviceName / methodName), so no
// definition lookup is needed. V2 is the default parse of the agent views
// (`show --compact` / `--story`); the save pipeline (V2, the only write route)
// works on the raw V2 body, not on this parse.

import type { V2Step, V2StepInput, V2Output, V2StepProperties } from "../../types/v2-wire";
import type {
  ParsedStep,
  CustomCodeStep,
  SpelEchoStep,
  SqlStep,
  RedisStep,
  ExistingServiceStep,
  UnknownStep,
  MethodOutput,
  StepInput,
} from "../../types/common";
import { decodeBase64Strict } from "../../base64";
import { classifyService, resolveStepIdentity, type ParseOptions } from "./classify";

export function parseV2Step(raw: V2Step, orderIndex: number, warn: (msg: string) => void, opts?: ParseOptions): ParsedStep {
  const base = buildBase(raw, orderIndex);
  const propsType = raw.properties?.type;

  if (!propsType) {
    return { ...base, kind: "UNKNOWN", reason: "missing properties.type" } as UnknownStep;
  }

  if (propsType === "CUSTOM_CODE") {
    const cc = raw.properties?.customCode;
    const inline = typeof cc?.inlineCode === "string" ? cc.inlineCode : "";
    const decoded = inline.length > 0 ? decodeBase64Strict(inline) : null;
    const source = decoded ?? inline;
    return {
      ...base,
      kind: "CUSTOM_CODE",
      language: cc?.language ?? null,
      customCodeEnv: cc?.executor ?? undefined,
      source,
      sourceEncoding: decoded !== null ? "BASE_64" : "NONE",
    } as CustomCodeStep;
  }

  // EXISTING_SERVICE — the V2 wire names the service (`serviceName` is the
  // automation-system name, e.g. `db_service`; `methodName` the API label).
  const identity = resolveStepIdentity(
    { automationApiId: raw.automationAPIId, serviceName: raw.serviceName, methodName: raw.methodName },
    opts,
  );
  if (identity) {
    base.serviceName = identity.system;
    base.methodName = identity.api;
    if (identity.apiUuid) base.automationApiUuid = identity.apiUuid;
  }
  const family = classifyService(identity);

  if (family.kind === "SPEL_ECHO") {
    const first = (raw.inputs ?? [])[0];
    return {
      ...base,
      kind: "SPEL_ECHO",
      expression: typeof first?.value === "string" ? first.value : null,
    } as SpelEchoStep;
  }

  if (family.kind === "SQL") {
    const slot = findSqlInput(raw.inputs);
    let sql = "";
    let encoding: "BASE_64" | "NONE" = "NONE";
    if (slot && typeof slot.value === "string") {
      const decoded = slot.encodingType === "BASE_64" && slot.value.length > 0 ? decodeBase64Strict(slot.value) : null;
      if (decoded !== null) {
        sql = decoded;
        encoding = "BASE_64";
      } else {
        sql = slot.value;
      }
    } else {
      warn(`[step ${base.orderIndex}] SQL step has no queryString input`);
    }
    const shape = findInputDeep(raw.inputs, (i) => i.displayWidgetSuggestion === "DROPDOWN" && typeof i.value === "string");
    const accountId = raw.accountConfiguration?.id;
    const authId = typeof accountId === "number" ? accountId : typeof accountId === "string" && /^\d+$/.test(accountId) ? Number(accountId) : undefined;
    return {
      ...base,
      kind: "SQL",
      operation: family.operation,
      sql,
      sqlEncoding: encoding,
      sqlInputUuid: typeof slot?.uuid === "string" ? slot.uuid.trim() : undefined,
      resultShape: typeof shape?.value === "string" ? shape.value : undefined,
      automationAuthId: authId,
    } as SqlStep;
  }

  if (family.kind === "REDIS_GET" || family.kind === "REDIS_SET" || family.kind === "REDIS_REMOVE") {
    const byKey = (...keys: string[]): string | undefined => {
      const i = findInputDeep(raw.inputs, (inp) => keys.includes(String(inp.key ?? "").toLowerCase()) && typeof inp.value === "string");
      return typeof i?.value === "string" ? i.value : undefined;
    };
    const step: RedisStep = {
      ...base,
      kind: family.kind,
      key: byKey("key"),
      value: byKey("value"),
      // some envs key them expirationSeconds / scope / canReplace.
      ttlSeconds: byKey("expiry", "ttl", "expirationseconds"),
      store: byKey("store", "scope"),
      overwrite: byKey("overwrite", "canreplace"),
    };
    return step;
  }

  return { ...base, kind: "EXISTING_SERVICE" } as ExistingServiceStep;
}

/** Depth-first over V2 inputs and their nested `properties`. */
function findInputDeep(inputs: unknown[] | undefined, pred: (i: V2StepInput) => boolean): V2StepInput | undefined {
  if (!Array.isArray(inputs)) return undefined;
  for (const raw of inputs) {
    if (!raw || typeof raw !== "object") continue;
    const i = raw as V2StepInput;
    if (pred(i)) return i;
    const nested = findInputDeep(i.properties, pred);
    if (nested) return nested;
  }
  return undefined;
}

/** The query slot: `body.queryString` (db_service), else the first BASE_64-flagged string input. */
function findSqlInput(inputs: V2StepInput[] | undefined): V2StepInput | undefined {
  return (
    findInputDeep(inputs, (i) => i.key === "queryString" && typeof i.value === "string") ??
    findInputDeep(inputs, (i) => i.encodingType === "BASE_64" && typeof i.value === "string")
  );
}

const nonBlank = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;

/**
 * V2 loop → the version-neutral loop fields. A step loops when the object
 * names a type, a value or a range (real wire), or says `enabled: true`
 * (older shape). `null` / absent / all-null → no loop.
 */
export function parseV2Loop(rse: V2StepProperties["repeatStepExecution"]): {
  repeatStepExecution?: boolean;
  loopExecutionSource?: string;
  loopConfiguration?: NonNullable<ParsedStep["loopConfiguration"]>;
} {
  if (!rse || typeof rse !== "object") return {};
  const type = nonBlank(rse.type);
  const start = nonBlank(rse.rangeStartInclusive);
  const range = start !== undefined ? `${start}..${nonBlank(rse.rangeEndExclusive) ?? ""}` : undefined;
  const source = nonBlank(rse.value) ?? range ?? nonBlank(rse.source);
  const enabled = rse.enabled === true || !!type || !!source;
  if (!enabled) return rse.enabled === false ? { repeatStepExecution: false } : {};
  const config: NonNullable<ParsedStep["loopConfiguration"]> = {};
  if (typeof rse.executeParallel === "boolean") config.executeParallel = rse.executeParallel;
  if (type) config.type = type;
  const counter = nonBlank(rse.counter);
  if (counter) config.counter = counter;
  if (typeof rse.numberOfConcurrentThread === "number") config.numberOfConcurrentThread = rse.numberOfConcurrentThread;
  return { repeatStepExecution: true, ...(source ? { loopExecutionSource: source } : {}), loopConfiguration: config };
}

function buildBase(raw: V2Step, orderIndex: number) {
  return {
    orderIndex,
    description: raw.description,
    automationApiId: raw.automationAPIId,
    automationApiUuid: undefined as string | undefined,
    serviceName: raw.serviceName,
    methodName: raw.methodName,
    runAsync: raw.properties?.runAsync,
    streamCapable: undefined,
    ...parseV2Loop(raw.properties?.repeatStepExecution),
    conditionMode: undefined,
    conditionExpression: raw.properties?.entryCondition?.expression ?? undefined,
    conditionConfiguration: undefined,
    forceExitFromFailure: raw.properties?.exitCondition?.exitOnFailure?.value,
    forceExitErrorMessage: raw.properties?.exitCondition?.exitOnFailure?.message,
    forceExitStatusCode: raw.properties?.exitCondition?.exitOnFailure?.code ?? undefined,
    outputs: (raw.outputs ?? []).map(mapOutput),
    inputs: (raw.inputs ?? []).map(mapInput),
    raw,
  };
}

function mapOutput(o: V2Output): MethodOutput {
  return {
    code: o.key,
    displayName: o.name,
    type: o.type,
    description: o.description,
    inputReference: o.inputReference,
    rawResponseContainer: o.rawResponseContainer,
    raw: o,
  };
}

function mapInput(i: V2StepInput): StepInput {
  const nested = Array.isArray(i.properties)
    ? (i.properties as unknown[]).filter((p): p is V2StepInput => !!p && typeof p === "object" && "key" in p)
    : [];
  return {
    key: i.key,
    label: typeof i.name === "string" && i.name.length > 0 ? i.name : undefined,
    automationUserInputUuid: typeof i.uuid === "string" ? i.uuid.trim() : undefined,
    value: i.value ?? null,
    mappings: nested.length > 0 ? nested.map(mapInput) : undefined,
    combineInput: i.combineInput,
    encodingType: i.encodingType,
    reference: i.reference,
    raw: i,
  };
}
