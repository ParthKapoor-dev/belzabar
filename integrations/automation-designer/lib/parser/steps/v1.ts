// Parse a single V1 service step into a ParsedStep.

import type { V1ServiceStep, V1Mapping, V1OutputField, V1InputField } from "../../types/v1-wire";
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
import {
  SHARED_STEP_CONSTANTS,
  findMappingByInputId,
  isRedisApiIdV1,
  sqlOperationForApiIdV1,
  walkMappingTree,
} from "./shared";

export interface Warn {
  (msg: string): void;
}

export function parseV1Step(raw: V1ServiceStep, orderIndex: number, warn: Warn): ParsedStep {
  const base = buildBase(raw, orderIndex);
  const activeTabId = raw.activeTab?.id;

  if (activeTabId === "customCode") {
    return buildCustomCode(raw, base, warn);
  }

  if (activeTabId === "existingService" || raw.automationApiId != null) {
    const apiId = typeof raw.automationApiId === "number" ? raw.automationApiId : null;

    if (apiId === SHARED_STEP_CONSTANTS.ECHO_API_ID_V1) {
      return buildSpelEcho(raw, base);
    }
    if (apiId != null) {
      const sqlOp = sqlOperationForApiIdV1(apiId);
      if (sqlOp) return buildSql(raw, base, sqlOp, warn);

      const redisKind = isRedisApiIdV1(apiId);
      if (redisKind) return buildRedis(raw, base, redisKind);
    }

    return buildExistingService(raw, base);
  }

  return buildUnknown(raw, base, "step has no activeTab.id and no automationApiId");
}

// ─── builders ────────────────────────────────────────────────────────────

interface BaseFields {
  orderIndex: number;
  description?: string;
  automationId?: string;
  automationApiId?: number;
  runAsync?: boolean;
  streamCapable?: boolean;
  repeatStepExecution?: boolean;
  loopExecutionSource?: string;
  loopConfiguration?: { executeParallel?: boolean; type?: string };
  conditionMode?: "advance" | "basic";
  conditionExpression?: string;
  conditionConfiguration?: unknown;
  forceExitFromFailure?: boolean;
  forceExitErrorMessage?: string;
  outputs: MethodOutput[];
  inputs: StepInput[];
  raw: unknown;
}

function buildBase(raw: V1ServiceStep, orderIndex: number): BaseFields {
  return {
    orderIndex: raw.orderIndex ?? orderIndex,
    description: raw.description,
    automationId: raw.automationId,
    automationApiId: typeof raw.automationApiId === "number" ? raw.automationApiId : undefined,
    runAsync: raw.runAsync,
    streamCapable: raw.streamCapable,
    repeatStepExecution: raw.repeatStepExecution,
    loopExecutionSource: raw.loopExecutionSource,
    loopConfiguration: raw.loopConfiguration,
    conditionMode: raw.conditionMode,
    conditionExpression: raw.conditionExpression,
    conditionConfiguration: raw.conditionConfiguration,
    forceExitFromFailure: raw.forceExitFromFailure,
    forceExitErrorMessage: raw.forceExitErrorMessage,
    outputs: (raw.outputs ?? []).map(mapOutput),
    inputs: (raw.mappings ?? []).map(mapMapping),
    raw,
  };
}

function mapOutput(o: V1OutputField): MethodOutput {
  return {
    code: o.code,
    displayName: o.displayName,
    type: o.type,
    automationAPIOutputId: o.automationAPIOutputId,
    internalVarRef: o.internalVarRef,
    rawResponseContainer: o.rawResponseContainer,
    raw: o,
  };
}

function mapMapping(m: V1Mapping): StepInput {
  return {
    automationUserInputId: m.automationUserInputId,
    automationUserInputUuid: m.automationUserInputUuid,
    value: m.value ?? null,
    combineInput: m.combineInputs,
    uiRepresentation: m.uiRepresentation,
    encodingType: m.encodingType,
    securedInput: m.securedInput,
    mappings: Array.isArray(m.mappings) ? m.mappings.map(mapMapping) : undefined,
    raw: m,
  };
}

function buildCustomCode(raw: V1ServiceStep, base: BaseFields, warn: Warn): CustomCodeStep {
  const code = typeof raw.code === "string" ? raw.code : "";
  const source = code.length > 0
    ? decodeBase64Safe(code, msg => warn(`[step ${base.orderIndex}] ${msg}`))
    : "";
  return {
    ...base,
    kind: "CUSTOM_CODE",
    language: normalizeLanguage(raw.language ?? null),
    customCodeEnv: typeof raw.customCodeEnv === "string" ? raw.customCodeEnv : undefined,
    source,
    sourceEncoding: code.length > 0 ? "BASE_64" : "NONE",
  };
}

function normalizeLanguage(lang: string | null): CustomCodeStep["language"] {
  if (lang == null) return null;
  const upper = lang.toUpperCase();
  if (upper === "JAVASCRIPT" || upper === "PYTHON" || upper === "JAVA" || upper === "COBOL" || upper === "PERL") {
    return upper;
  }
  return null;
}

function buildSpelEcho(raw: V1ServiceStep, base: BaseFields): SpelEchoStep {
  // Echo's SpEL expression lives in the first root mapping's `value`.
  const firstMapping = Array.isArray(raw.mappings) ? raw.mappings[0] : undefined;
  const expression = typeof firstMapping?.value === "string" ? firstMapping.value : null;
  return {
    ...base,
    kind: "SPEL_ECHO",
    expression,
  };
}

function buildSql(raw: V1ServiceStep, base: BaseFields, operation: string, warn: Warn): SqlStep {
  let sql = "";
  let encoding: "BASE_64" | "NONE" = "NONE";
  let resultShape: string | undefined;

  for (const m of walkMappingTree(raw.mappings)) {
    if (encoding === "NONE" && typeof m.value === "string" && m.encodingType === "BASE_64") {
      sql = decodeBase64Safe(m.value, msg => warn(`[step ${base.orderIndex}] SQL ${msg}`));
      encoding = "BASE_64";
    }
    if (resultShape === undefined && m.uiRepresentation === "DROPDOWN" && typeof m.value === "string") {
      resultShape = m.value;
    }
    if (sql !== "" && resultShape !== undefined) break;
  }

  return {
    ...base,
    kind: "SQL",
    operation,
    sql,
    sqlEncoding: encoding,
    resultShape,
    automationAuthId: typeof raw.automationAuthId === "number" ? raw.automationAuthId : undefined,
    testAccountId: typeof raw.testAccountId === "number" ? raw.testAccountId : undefined,
  };
}

function buildRedis(raw: V1ServiceStep, base: BaseFields, kind: "REDIS_GET" | "REDIS_SET" | "REDIS_REMOVE"): RedisStep {
  // Sub-input IDs per ad-rest-api-step-types.md §Cache.Redis. GET and REMOVE
  // share the parent OBJECT structure; SET has additional value/TTL/overwrite
  // sub-mappings.
  const getKeyId = 41954;    // GET parent
  const getKeyChildId = 41955;
  const removeKeyId = 41954; // docs reuse GET's IDs shape for remove
  const removeKeyChildId = 41955;
  const setKeyChildId = 41958;
  const setValueChildId = 41959;
  const setStoreChildId = 41960;
  const setTtlChildId = 41961;
  const setOverwriteChildId = 41962;

  const findValue = (id: number): string | undefined => {
    const m = findMappingByInputId(raw.mappings, id);
    return typeof m?.value === "string" ? m.value : undefined;
  };

  if (kind === "REDIS_GET" || kind === "REDIS_REMOVE") {
    return {
      ...base,
      kind,
      key: findValue(kind === "REDIS_GET" ? getKeyChildId : removeKeyChildId),
      store: findValue(kind === "REDIS_GET" ? getKeyId + 2 : removeKeyId + 2),
    };
  }

  return {
    ...base,
    kind: "REDIS_SET",
    key: findValue(setKeyChildId),
    value: findValue(setValueChildId),
    store: findValue(setStoreChildId),
    ttlSeconds: findValue(setTtlChildId),
    overwrite: findValue(setOverwriteChildId),
  };
}

function buildExistingService(raw: V1ServiceStep, base: BaseFields): ExistingServiceStep {
  return {
    ...base,
    kind: "EXISTING_SERVICE",
  };
}

function buildUnknown(raw: V1ServiceStep, base: BaseFields, reason: string): UnknownStep {
  return {
    ...base,
    kind: "UNKNOWN",
    reason,
  };
}

// Re-export for fixture-building convenience in tests.
export const __testExports = { mapOutput, mapMapping };
