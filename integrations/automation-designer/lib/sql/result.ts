import { ErrorParser, type ParsedError } from "../error-parser";
import type { SqlRunParseResult, SqlUpdateRunParseResult, SqlInsertRunParseResult, SqlModifyRunParseResult } from "./types";

function parseMaybeJsonArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) && typeof value !== "string") {
    return null;
  }

  if (Array.isArray(value)) {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseMaybeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function parseSqlRunResult(result: any): SqlRunParseResult {
  const services = Array.isArray(result?.services) ? result.services : [];

  let rows: unknown[] = [];
  let rowsCountFromOutput: number | null = null;

  for (const service of services) {
    const outputs = Array.isArray(service?.outputs) ? service.outputs : [];
    for (const output of outputs) {
      if (rows.length === 0) {
        const parsedRows = parseMaybeJsonArray(output?.testResult);
        if (parsedRows) {
          rows = parsedRows;
        }
      }

      const numericOutput = parseMaybeNumber(output?.testResult);
      if (numericOutput !== null) {
        rowsCountFromOutput = numericOutput;
      }
    }
  }

  const executionStatus = result?.executionStatus || {};
  const statusCode = parseMaybeNumber(executionStatus.statusCode) ?? undefined;
  const totalExecutionTime = executionStatus.totalExecutionTime;

  const executionTime =
    totalExecutionTime && typeof totalExecutionTime.time === "number" && typeof totalExecutionTime.unit === "string"
      ? {
          time: totalExecutionTime.time,
          unit: totalExecutionTime.unit,
        }
      : undefined;

  const success = executionStatus.failed === false;
  const rowCount = rows.length > 0 ? rows.length : rowsCountFromOutput ?? 0;

  return {
    rows,
    rowCount,
    statusCode,
    executionTime,
    success,
  };
}

export function parseSqlUpdateResult(result: any): SqlUpdateRunParseResult {
  const services = Array.isArray(result?.services) ? result.services : [];

  let rowsAffected = 0;
  for (const service of services) {
    const outputs = Array.isArray(service?.outputs) ? service.outputs : [];
    for (const output of outputs) {
      const numericOutput = parseMaybeNumber(output?.testResult);
      if (numericOutput !== null) {
        rowsAffected = numericOutput;
        break;
      }
    }
  }

  const executionStatus = result?.executionStatus || {};
  const statusCode = parseMaybeNumber(executionStatus.statusCode) ?? undefined;
  const totalExecutionTime = executionStatus.totalExecutionTime;

  const executionTime =
    totalExecutionTime && typeof totalExecutionTime.time === "number" && typeof totalExecutionTime.unit === "string"
      ? { time: totalExecutionTime.time, unit: totalExecutionTime.unit }
      : undefined;

  return {
    rowsAffected,
    statusCode,
    executionTime,
    success: executionStatus.failed === false,
  };
}

/** Output ids of the insert operation, by what they consume (from its `automationAPIOutputs`). */
interface SqlInsertOutputIds {
  rows: number[];
  generated: number[];
}

/** Read the insert operation's output ids: `rowsImpacted` → rows; `generatedId` / `uuid` → generated. */
export function insertOutputIds(operation: unknown): SqlInsertOutputIds {
  const outs = Array.isArray((operation as any)?.automationAPIOutputs) ? (operation as any).automationAPIOutputs : [];
  const ids = (pred: (c: string) => boolean) =>
    outs.filter((o: any) => pred(String(o?.consumes ?? ""))).map((o: any) => Number(o.id)).filter(Number.isFinite);
  return {
    rows: ids((c) => c === "rowsImpacted"),
    generated: ids((c) => c === "generatedId" || c === "uuid"),
  };
}

// The platform's JDBC getKey() refuses multi-row RETURNING, AFTER the insert
// committed, and names the keys in the message (live):
//   "DB execution failed: The getKey method should only be used when a single
//    key is returned. The current key entry contains multiple keys: [{id=3}, {id=4}]"
const MULTI_KEY = /contains multiple keys:\s*\[(.*)\]\s*$/s;

/** Parse `[{id=3}, {id=4, name=x}]` key entries out of the getKey error (null if not that error). */
export function parseMultipleKeysError(message: unknown): Array<Record<string, string>> | null {
  if (typeof message !== "string") return null;
  const m = MULTI_KEY.exec(message.trim());
  if (!m) return null;
  const entries = [...m[1]!.matchAll(/\{([^}]*)\}/g)].map((e) => {
    const rec: Record<string, string> = {};
    for (const pair of e[1]!.split(/,\s*/)) {
      const i = pair.indexOf("=");
      if (i > 0) rec[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    return rec;
  });
  return entries.length > 0 ? entries : null;
}

/**
 * Parse an insert execution. With `outputIds` (from the operation metadata)
 * outputs are read by id: rowsImpacted → rowsAffected, generatedId/uuid →
 * generatedValues. Without it, the old heuristic (first number = rows,
 * non-numeric strings = generated) applies.
 */
export function parseSqlInsertResult(result: any, outputIds?: SqlInsertOutputIds): SqlInsertRunParseResult {
  const services = Array.isArray(result?.services) ? result.services : [];

  let rowsAffected = 0;
  const generatedValues: string[] = [];

  for (const service of services) {
    const outputs = Array.isArray(service?.outputs) ? service.outputs : [];
    for (const output of outputs) {
      const raw = output?.testResult;
      if (raw == null || raw === "") continue;
      const outId = Number(output?.automationAPIOutputId);

      if (outputIds && outputIds.rows.includes(outId)) {
        rowsAffected = parseMaybeNumber(raw) ?? rowsAffected;
        continue;
      }
      if (outputIds && outputIds.generated.includes(outId)) {
        if (typeof raw === "string" || typeof raw === "number") generatedValues.push(String(raw).trim());
        continue;
      }

      const asNumber = parseMaybeNumber(raw);
      if (asNumber !== null) {
        if (rowsAffected === 0) rowsAffected = asNumber;
        continue;
      }

      if (typeof raw === "string" && parseMaybeJsonArray(raw) === null) {
        generatedValues.push(raw.trim());
      }
    }
  }

  const executionStatus = result?.executionStatus || {};
  const statusCode = parseMaybeNumber(executionStatus.statusCode) ?? undefined;
  const totalExecutionTime = executionStatus.totalExecutionTime;

  const executionTime =
    totalExecutionTime && typeof totalExecutionTime.time === "number" && typeof totalExecutionTime.unit === "string"
      ? { time: totalExecutionTime.time, unit: totalExecutionTime.unit }
      : undefined;

  return {
    rowsAffected,
    generatedValues,
    statusCode,
    executionTime,
    success: executionStatus.failed === false,
  };
}

export function parseSqlModifyResult(result: any): SqlModifyRunParseResult {
  const executionStatus = result?.executionStatus || {};
  const statusCode = parseMaybeNumber(executionStatus.statusCode) ?? undefined;
  const totalExecutionTime = executionStatus.totalExecutionTime;

  const executionTime =
    totalExecutionTime && typeof totalExecutionTime.time === "number" && typeof totalExecutionTime.unit === "string"
      ? { time: totalExecutionTime.time, unit: totalExecutionTime.unit }
      : undefined;

  return {
    statusCode,
    executionTime,
    success: executionStatus.failed === false,
  };
}

/**
 * The database's own message from a failed-statement text: the Java exception
 * class names, Spring's `SQL [<comment> <query>]: ` / `bad SQL grammar [<query>];`
 * wrappers and Postgres's `ERROR: ` prefix removed, `Position: N` kept as
 * `(position N)`. Live, a bad column gives
 * `org.postgresql.util.PSQLException: ERROR: column "x" does not exist\n  Position: 8`.
 */
export function sqlDatabaseMessage(raw: string): string {
  let msg = raw.trim();
  const nested = msg.lastIndexOf("nested exception is ");
  if (nested >= 0) msg = msg.slice(nested + "nested exception is ".length);
  const wrapped = /(?:bad SQL grammar \[|SQL \[)/.exec(msg);
  if (wrapped) {
    const end = Math.max(msg.lastIndexOf("]: "), msg.lastIndexOf("]; "));
    if (end > wrapped.index) msg = msg.slice(end + 3);
  }
  for (;;) {
    const next = msg.replace(/^(?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error)\s*:\s*/, "").replace(/^ERROR:\s+/, "");
    if (next === msg) break;
    msg = next;
  }
  return msg.replace(/\s*\n\s*Position:\s*(\d+)\s*$/, " (position $1)").trim();
}

/** The errors the server raises for a `?` / `:name` it read as a bind parameter. */
const PARAMETER_ERROR = /given \d+ parameters but expected \d+|No value (?:supplied|registered) for (?:the SQL parameter|key)/i;

interface SqlFailure {
  /** For `error.message`: the database's own message. */
  message: string;
  /** For `error.details.error`: the query is not repeated in it (it is `details.query`). */
  error: ParsedError | null;
  /** The execution status without its copies of the message. */
  executionStatus: Record<string, unknown> | undefined;
}

/**
 * Describe a failed SQL test execution once. The raw response repeats the
 * failing message, with the whole query inside it, in the step status, its
 * `errorMessage`, the top status and its `errorMessage`: a typo in a 37 KB
 * query made a ~180 KB envelope. Here the message appears once, with any copy
 * of the query replaced by `<query>`.
 */
export function describeSqlFailure(executionResult: any, query: string): SqlFailure {
  const services = Array.isArray(executionResult?.services) ? executionResult.services : [];
  const failedService = services.find((svc: any) => svc?.executionStatus?.failed);
  const status =
    failedService?.executionStatus ??
    executionResult?.executionStatus?.failingStepsStatuses?.[0] ??
    executionResult?.executionStatus;
  const parsed = status?.message ? ErrorParser.parse(status) : null;
  const q = query.trim();
  const error = parsed ? { ...parsed, detail: q ? parsed.detail.split(q).join("<query>") : parsed.detail } : null;
  let message = error ? (error.type === "DB" ? sqlDatabaseMessage(error.detail) : error.summary) : "";
  if (PARAMETER_ERROR.test(message)) {
    message += " (the server read a '?' or ':name' as a bind parameter: write '??' for the jsonb operators and arr[1: 6] for slices)";
  }
  const st = executionResult?.executionStatus;
  const executionStatus =
    st && typeof st === "object"
      ? Object.fromEntries(Object.entries(st).filter(([k]) => !REPEATED_STATUS_KEYS.has(k)))
      : undefined;
  return { message, error, executionStatus };
}

/** Status keys that only repeat the failing message (and the query in it), or the call list. */
const REPEATED_STATUS_KEYS = new Set(["message", "errorMessage", "failingStepsStatuses", "calls"]);
