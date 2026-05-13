// Parse a single V2 step into a ParsedStep.
//
// V2 is thinner than V1: we only need enough discrimination so `belz ad show
// --v2` can render a method parsed via V2. Write-side support for V2 is out
// of scope for the current phase — the V2 parser feeds read commands only.

import type { V2Step, V2StepInput, V2Output } from "../../types/v2-wire";
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
import { decodeBase64Safe } from "../../base64";

export function parseV2Step(raw: V2Step, orderIndex: number, warn: (msg: string) => void): ParsedStep {
  const base = buildBase(raw, orderIndex);
  const propsType = raw.properties?.type;

  if (!propsType) {
    return { ...base, kind: "UNKNOWN", reason: "missing properties.type" } as UnknownStep;
  }

  if (propsType === "CUSTOM_CODE") {
    const cc = raw.properties?.customCode;
    const source = typeof cc?.inlineCode === "string" ? cc.inlineCode : "";
    return {
      ...base,
      kind: "CUSTOM_CODE",
      language: cc?.language ?? null,
      customCodeEnv: cc?.executor ?? undefined,
      source,
      sourceEncoding: "NONE",
    } as CustomCodeStep;
  }

  // EXISTING_SERVICE — discriminate further by serviceName / methodName.
  const svc = raw.serviceName ?? "";
  const mth = raw.methodName ?? "";

  if (svc === "Helpers.Legacy" && mth === "echo") {
    const first = (raw.inputs ?? [])[0];
    return {
      ...base,
      kind: "SPEL_ECHO",
      expression: typeof first?.value === "string" ? first.value : null,
    } as SpelEchoStep;
  }

  if (svc === "Database.SQL") {
    const operation = normaliseSqlOperation(mth);
    const sqlInput = findInputByEncoding(raw.inputs, "BASE_64");
    const shapeInput = (raw.inputs ?? []).find(i => i.key?.toLowerCase().includes("shape") || i.key?.toLowerCase().includes("result"));
    let sql = "";
    let encoding: "BASE_64" | "NONE" = "NONE";
    if (sqlInput && typeof sqlInput.value === "string") {
      sql = decodeBase64Safe(sqlInput.value, m => warn(`[step ${base.orderIndex}] SQL ${m}`));
      encoding = "BASE_64";
    } else {
      const plain = (raw.inputs ?? []).find(i => typeof i.value === "string" && i.value.trim().length > 0);
      if (plain && typeof plain.value === "string") sql = plain.value;
    }
    return {
      ...base,
      kind: "SQL",
      operation,
      sql,
      sqlEncoding: encoding,
      resultShape: typeof shapeInput?.value === "string" ? shapeInput.value : undefined,
    } as SqlStep;
  }

  if (svc === "Cache.Redis") {
    const m = mth.toLowerCase();
    const kind: RedisStep["kind"] =
      m === "get" ? "REDIS_GET" : m === "set" ? "REDIS_SET" : m === "remove" ? "REDIS_REMOVE" : "REDIS_GET";
    const byKey = (k: string): string | undefined => {
      const i = (raw.inputs ?? []).find(inp => inp.key === k);
      return typeof i?.value === "string" ? i.value : undefined;
    };
    const step: RedisStep = {
      ...base,
      kind,
      key: byKey("key"),
      value: byKey("value"),
      ttlSeconds: byKey("expiry") ?? byKey("ttl"),
      store: byKey("store"),
      overwrite: byKey("overwrite"),
    };
    return step;
  }

  return { ...base, kind: "EXISTING_SERVICE" } as ExistingServiceStep;
}

function normaliseSqlOperation(methodName: string): string {
  const m = methodName.toLowerCase();
  if (m.includes("read")) return "read";
  if (m.includes("update")) return "update";
  if (m.includes("add") || m.includes("insert")) return "add";
  if (m.includes("delete")) return "delete";
  if (m.includes("schema")) return "schema.modify";
  return methodName;
}

function findInputByEncoding(inputs: V2StepInput[] | undefined, encoding: string): V2StepInput | undefined {
  return (inputs ?? []).find(i => i.encodingType === encoding);
}

function buildBase(raw: V2Step, orderIndex: number) {
  return {
    orderIndex,
    description: raw.description,
    automationApiId: raw.automationAPIId,
    serviceName: raw.serviceName,
    methodName: raw.methodName,
    runAsync: raw.properties?.runAsync,
    streamCapable: undefined,
    repeatStepExecution: raw.properties?.repeatStepExecution?.enabled,
    loopExecutionSource: typeof raw.properties?.repeatStepExecution?.source === "string"
      ? raw.properties.repeatStepExecution.source
      : undefined,
    loopConfiguration: {
      executeParallel: raw.properties?.repeatStepExecution?.executeParallel,
    },
    conditionMode: undefined,
    conditionExpression: raw.properties?.entryCondition?.expression ?? undefined,
    conditionConfiguration: undefined,
    forceExitFromFailure: raw.properties?.exitCondition?.exitOnFailure?.value,
    forceExitErrorMessage: raw.properties?.exitCondition?.exitOnFailure?.message,
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
  return {
    key: i.key,
    value: i.value ?? null,
    combineInput: i.combineInput,
    encodingType: i.encodingType,
    reference: i.reference,
    raw: i,
  };
}
