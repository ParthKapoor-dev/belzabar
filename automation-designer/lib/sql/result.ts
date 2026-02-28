import type { SqlRunParseResult } from "./types";

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
