// Parse a single V1 service step into a ParsedStep.

import type { V1ServiceStep, V1Mapping, V1OutputField } from "../../types/v1-wire";
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
  ConditionRow,
} from "../../types/common";
import { decodeBase64Strict } from "../../base64";
import { findMappingByInputId, walkMappingTree } from "./shared";
import {
  classifyService,
  resolveStepIdentity,
  type ParseOptions,
  type ServiceIdentity,
} from "./classify";

interface Warn {
  (msg: string): void;
}

export function parseV1Step(raw: V1ServiceStep, orderIndex: number, warn: Warn, opts?: ParseOptions): ParsedStep {
  const base = buildBase(raw, orderIndex);
  const activeTabId = raw.activeTab?.id;

  if (activeTabId === "customCode") {
    return buildCustomCode(raw, base, warn);
  }

  if (activeTabId === "existingService" || raw.automationApiId != null) {
    // classify by the service the step calls, not by env-local numeric ids.
    const identity = resolveStepIdentity(
      {
        automationId: raw.automationId,
        automationApiId: raw.automationApiId,
        automationApiUuid: typeof raw.automationApiUuid === "string" ? raw.automationApiUuid : undefined,
        categoryName: typeof raw.categoryName === "string" ? raw.categoryName : undefined,
      },
      opts,
    );
    if (identity) {
      base.serviceName = identity.system;
      base.methodName = identity.api;
      if (identity.apiUuid) base.automationApiUuid = identity.apiUuid;
    }
    const family = classifyService(identity);
    switch (family.kind) {
      case "SPEL_ECHO":
        return buildSpelEcho(raw, base);
      case "SQL":
        return buildSql(raw, base, family.operation, identity);
      case "REDIS_GET":
      case "REDIS_SET":
      case "REDIS_REMOVE":
        return buildRedis(raw, base, family.kind, identity);
      default:
        return buildExistingService(raw, base);
    }
  }

  return buildUnknown(raw, base, "step has no activeTab.id and no automationApiId");
}

// ─── builders ────────────────────────────────────────────────────────────

interface BaseFields {
  orderIndex: number;
  description?: string;
  automationId?: string;
  automationApiId?: number;
  automationApiUuid?: string;
  serviceName?: string;
  methodName?: string;
  runAsync?: boolean;
  streamCapable?: boolean;
  repeatStepExecution?: boolean;
  loopExecutionSource?: string;
  loopConfiguration?: { executeParallel?: boolean; type?: string };
  conditionMode?: "advance" | "basic";
  conditionExpression?: string;
  conditionConfiguration?: unknown;
  conditionRows?: ConditionRow[];
  forceExitFromFailure?: boolean;
  forceExitErrorMessage?: string;
  forceExitStatusCode?: number | string;
  forceReturnExpression?: string;
  forceReturnMode?: "advance" | "basic";
  forceReturnRows?: ConditionRow[];
  forceReturnStatusCode?: number | string;
  forceReturnMessage?: string;
  account?: { id?: number | string; name?: string };
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
    conditionRows: parseConditionRows(raw.condition),
    forceExitFromFailure: raw.forceExitFromFailure,
    forceExitErrorMessage: raw.forceExitErrorMessage,
    forceExitStatusCode: raw.forceExitStatusCode ?? undefined,
    ...parseForceReturn(raw),
    ...(parseAccount(raw) ?? {}),
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
  // V1 stores `code` either as plain text (most a dev env steps) or as base64.
  // The runtime content-sniffs; we do the same with a *strict* decoder so
  // plain JS is never mangled into garbage by a lenient base64 decode.
  const { source, encoding } = decodeCustomCode(typeof raw.code === "string" ? raw.code : "");
  return {
    ...base,
    kind: "CUSTOM_CODE",
    language: normalizeLanguage(raw.language ?? null),
    customCodeEnv: typeof raw.customCodeEnv === "string" ? raw.customCodeEnv : undefined,
    source,
    sourceEncoding: encoding,
  };
}

/**
 * Decode a stored custom-code body. Canonical base64 → decoded text with
 * encoding BASE_64; anything else (including empty) is plain text, NONE.
 * Shared with the serializer so "was this step edited?" compares against the
 * exact same decoding.
 */
function decodeCustomCode(code: string): { source: string; encoding: "BASE_64" | "NONE" } {
  if (code.length === 0) return { source: "", encoding: "NONE" };
  const decoded = decodeBase64Strict(code);
  return decoded === null ? { source: code, encoding: "NONE" } : { source: decoded, encoding: "BASE_64" };
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

function buildSql(raw: V1ServiceStep, base: BaseFields, operation: string, identity: ServiceIdentity | null): SqlStep {
  const loc = locateSqlMapping(raw.mappings, { inputUuids: identity?.sqlInputUuids });
  let resultShape: string | undefined;
  for (const m of walkMappingTree(raw.mappings)) {
    if (m.uiRepresentation === "DROPDOWN" && typeof m.value === "string") {
      resultShape = m.value;
      break;
    }
  }

  return {
    ...base,
    kind: "SQL",
    operation,
    sql: loc?.sql ?? "",
    sqlEncoding: loc?.encoding ?? "NONE",
    sqlInputUuid: trimUuid(loc?.mapping.automationUserInputUuid),
    resultShape,
    automationAuthId: typeof raw.automationAuthId === "number" ? raw.automationAuthId : undefined,
    testAccountId: typeof raw.testAccountId === "number" ? raw.testAccountId : undefined,
  };
}

interface SqlMappingLocation {
  mapping: V1Mapping;
  sql: string;
  encoding: "BASE_64" | "NONE";
}

/**
 * Locate the mapping that holds a SQL step's query text. Shared by the parser
 * and the serializer so both always agree on *which* slot holds the SQL.
 *
 *   1. The first mapping flagged `encodingType: "BASE_64"` with a string value.
 *      Its encoding is BASE_64 only if the value is strict base64; a plain
 *      value under the flag is plain text (the server ignores the flag then).
 *   2. Otherwise, if there is exactly one non-empty CUSTOM leaf, that is the
 *      plaintext query (legacy chains, `encodingType` NONE/absent).
 *   3. Otherwise `null` — the slot is ambiguous and writes must be refused.
 *
 * `hint.inputUuids` (step 0) takes precedence when one of them is present.
 */
function locateSqlMapping(
  mappings: V1Mapping[] | undefined,
  hint: { inputUuids?: readonly string[] } = {},
): SqlMappingLocation | null {
  // 0. The service's own query input (definition `produces: queryString`), or
  //    the slot the parser picked (SqlStep.sqlInputUuid) — unambiguous on the envs captured,
  //    where the plain-text query sits beside other CUSTOM leaves.
  const wanted = new Set((hint.inputUuids ?? []).map((u) => u.trim().toLowerCase()).filter(Boolean));
  if (wanted.size > 0) {
    for (const m of walkMappingTree(mappings)) {
      const u = trimUuid(m.automationUserInputUuid)?.toLowerCase();
      if (u && wanted.has(u) && typeof m.value === "string") {
        const decoded = m.encodingType === "BASE_64" && m.value.length > 0 ? decodeBase64Strict(m.value) : null;
        return decoded === null
          ? { mapping: m, sql: m.value, encoding: "NONE" }
          : { mapping: m, sql: decoded, encoding: "BASE_64" };
      }
    }
  }
  for (const m of walkMappingTree(mappings)) {
    if (m.encodingType === "BASE_64" && typeof m.value === "string") {
      const decoded = m.value.length > 0 ? decodeBase64Strict(m.value) : null;
      return decoded === null
        ? { mapping: m, sql: m.value, encoding: "NONE" }
        : { mapping: m, sql: decoded, encoding: "BASE_64" };
    }
  }
  const leaves: V1Mapping[] = [];
  for (const m of walkMappingTree(mappings)) {
    const isLeaf = !Array.isArray(m.mappings) || m.mappings.length === 0;
    if (isLeaf && m.uiRepresentation === "CUSTOM" && typeof m.value === "string" && m.value.trim().length > 0) {
      leaves.push(m);
    }
  }
  if (leaves.length === 1) return { mapping: leaves[0]!, sql: leaves[0]!.value as string, encoding: "NONE" };
  return null;
}

function buildRedis(
  raw: V1ServiceStep,
  base: BaseFields,
  kind: "REDIS_GET" | "REDIS_SET" | "REDIS_REMOVE",
  identity: ServiceIdentity | null,
): RedisStep {
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

  // The numeric sub-input ids above are one env's; on other envs fall back to the
  // service's own input labels (from the definition) when the ids miss.
  const labels = identity?.inputLabels ?? {};
  const byLabel = new Map<string, string>();
  for (const m of walkMappingTree(raw.mappings)) {
    const label = labels[trimUuid(m.automationUserInputUuid) ?? ""] ?? labels[String(m.automationUserInputId ?? "")];
    if (label && typeof m.value === "string") byLabel.set(label.trim().toLowerCase(), m.value);
  }
  // some envs name them scope / expirationSeconds / canReplace.
  const LABEL_FOR: Record<number, string[]> = {
    [getKeyChildId]: ["key"],
    [getKeyId + 2]: ["store", "cache store", "scope"],
    [setKeyChildId]: ["key"],
    [setValueChildId]: ["value"],
    [setStoreChildId]: ["store", "cache store", "scope"],
    [setTtlChildId]: ["ttl", "expiry", "ttl (seconds)", "expirationseconds"],
    [setOverwriteChildId]: ["overwrite", "canreplace"],
  };
  const findValue = (id: number): string | undefined => {
    const m = findMappingByInputId(raw.mappings, id);
    if (typeof m?.value === "string") return m.value;
    for (const l of LABEL_FOR[id] ?? []) {
      const v = byLabel.get(l);
      if (v !== undefined) return v;
    }
    return undefined;
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

function buildExistingService(_raw: V1ServiceStep, base: BaseFields): ExistingServiceStep {
  return {
    ...base,
    kind: "EXISTING_SERVICE",
  };
}

function buildUnknown(_raw: V1ServiceStep, base: BaseFields, reason: string): UnknownStep {
  return {
    ...base,
    kind: "UNKNOWN",
    reason,
  };
}

function trimUuid(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** V1 basic-mode condition rows → `{field, operator, value}`. */
function parseConditionRows(rows: unknown[] | undefined): ConditionRow[] | undefined {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const out: ConditionRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, any>;
    const field = row.item?.nestedLabel ?? row.item?.fieldCode;
    const operator = row.operator?.value ?? row.operator?.name;
    out.push({
      field: typeof field === "string" ? field : "",
      operator: typeof operator === "string" ? operator : "",
      value: row.value == null ? null : String(row.value),
      ...(typeof row.groupOp?.value === "string" ? { groupOp: row.groupOp.value } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * V1 conditional exit. V1 has one status code / message pair
 * (`forceExitStatusCode` / `forceExitErrorMessage`) shared with exit-on-failure.
 */
function parseForceReturn(raw: V1ServiceStep): Partial<BaseFields> {
  const expr = typeof raw.forceReturnConditionExpression === "string" ? raw.forceReturnConditionExpression.trim() : "";
  const rows = parseConditionRows(raw.forceReturnCondition);
  if (!expr && !rows) return {};
  const code = raw.forceExitStatusCode ?? undefined;
  const message = typeof raw.forceExitErrorMessage === "string" && raw.forceExitErrorMessage ? raw.forceExitErrorMessage : undefined;
  return {
    ...(expr ? { forceReturnExpression: expr } : {}),
    ...(raw.forceReturnConditionMode ? { forceReturnMode: raw.forceReturnConditionMode } : {}),
    ...(rows ? { forceReturnRows: rows } : {}),
    ...(code != null && code !== "" ? { forceReturnStatusCode: code } : {}),
    ...(message ? { forceReturnMessage: message } : {}),
  };
}

/** V1 step account: `automationAuthId` (+ `accountName` on newer bodies). */
function parseAccount(raw: V1ServiceStep): { account: { id?: number | string; name?: string } } | undefined {
  const id = typeof raw.automationAuthId === "number" ? raw.automationAuthId : undefined;
  const name = typeof raw.accountName === "string" && raw.accountName.trim() ? raw.accountName.trim() : undefined;
  if (id === undefined && name === undefined) return undefined;
  return { account: { ...(id !== undefined ? { id } : {}), ...(name ? { name } : {}) } };
}
