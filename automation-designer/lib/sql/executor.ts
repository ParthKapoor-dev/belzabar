import { CliError } from "@belzabar/core";
import { ErrorParser } from "../error-parser";
import { fetchMethodDefinition, testMethod } from "../api";
import type { RawMethodResponse } from "../types";
import { fetchSqlDatabases, fetchSqlSelectOperation } from "./api";
import { buildSqlReadPayload } from "./payload";
import { parseSqlRunResult } from "./result";
import { normalizeSqlDatabases, resolveSqlDatabase } from "./selector";
import type {
  NormalizedSqlDatabase,
  SqlSelectOperation,
  SqlDbResolutionResult,
} from "./types";

export const DEFAULT_SQL_DB_FALLBACK = "NSM_Read_DB";

export interface SqlDbContext {
  databases: NormalizedSqlDatabase[];
  resolution: SqlDbResolutionResult;
}

export interface SqlExecutionContext {
  operation: SqlSelectOperation;
  template: RawMethodResponse;
}

export interface ExecuteSqlReadOptions {
  query: string;
  database: NormalizedSqlDatabase;
  context: SqlExecutionContext;
  raw?: boolean;
}

export interface ExecuteSqlReadResult {
  database: NormalizedSqlDatabase;
  query: string;
  statusCode?: number;
  rows: unknown[];
  rowCount: number;
  executionTime?: {
    time: number;
    unit: string;
  };
  raw?: {
    operation: unknown;
    payload: unknown;
    executionResult: unknown;
  };
}

export async function resolveSqlDbContext(options: {
  requestedDb?: string;
  envDefault?: string;
  fallbackNickname?: string;
}): Promise<SqlDbContext> {
  const rawDatabases = await fetchSqlDatabases();
  const databases = normalizeSqlDatabases(rawDatabases);
  const resolution = resolveSqlDatabase(databases, {
    requested: options.requestedDb,
    envDefault: options.envDefault,
    fallbackNickname: options.fallbackNickname ?? DEFAULT_SQL_DB_FALLBACK,
  });

  return {
    databases,
    resolution,
  };
}

export async function loadSqlExecutionContext(): Promise<SqlExecutionContext> {
  const operation = await fetchSqlSelectOperation();
  if (!operation?.methodUUID) {
    throw new CliError("SQL read operation metadata is missing methodUUID.", {
      code: "SQL_SELECT_METADATA_INVALID",
      details: operation,
    });
  }

  const template = (await fetchMethodDefinition(operation.methodUUID)) as RawMethodResponse;
  return {
    operation,
    template,
  };
}

export async function executeSqlReadQuery(options: ExecuteSqlReadOptions): Promise<ExecuteSqlReadResult> {
  const payload = buildSqlReadPayload({
    template: options.context.template,
    operation: options.context.operation,
    dbAuthId: options.database.id,
    query: options.query,
  });

  const formData = new FormData();
  formData.append("body", JSON.stringify(payload));

  const response = await testMethod(formData);
  if (!response.ok) {
    throw new CliError(`SQL execution request failed (${response.status}).`, {
      code: "SQL_EXECUTION_FAILED",
      details: await response.text(),
    });
  }

  const executionResult = await response.json();
  const parsed = parseSqlRunResult(executionResult);

  if (!parsed.success) {
    const failedService = (executionResult?.services || []).find((svc: any) => svc?.executionStatus?.failed);
    const parsedError = failedService?.executionStatus
      ? ErrorParser.parse(failedService.executionStatus)
      : null;

    throw new CliError("SQL query execution failed.", {
      code: "SQL_QUERY_FAILED",
      details: {
        database: options.database,
        query: options.query,
        statusCode: parsed.statusCode,
        error: parsedError,
        executionStatus: executionResult?.executionStatus,
      },
    });
  }

  const data: ExecuteSqlReadResult = {
    database: options.database,
    query: options.query,
    statusCode: parsed.statusCode,
    rows: parsed.rows,
    rowCount: parsed.rowCount,
    executionTime: parsed.executionTime,
  };

  if (options.raw) {
    data.raw = {
      operation: options.context.operation,
      payload,
      executionResult,
    };
  }

  return data;
}
