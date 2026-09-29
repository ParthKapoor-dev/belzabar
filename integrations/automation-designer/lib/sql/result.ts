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
