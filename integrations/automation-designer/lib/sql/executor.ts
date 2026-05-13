import { CliError } from "@belzabar/core";
import { ErrorParser } from "../error-parser";
import { fetchRawMethod, testMethodMultipart } from "../api/v1";
import type { V1RawMethodResponse } from "../types/v1-wire";
import { fetchSqlDatabases, fetchSqlSelectOperation, fetchSqlUpdateOperation, fetchSqlInsertOperation, fetchSqlModifyOperation } from "./api";
import { buildSqlReadPayload } from "./payload";
import { parseSqlRunResult, parseSqlUpdateResult, parseSqlInsertResult, parseSqlModifyResult } from "./result";
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
  template: V1RawMethodResponse;
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

  const template = (await fetchRawMethod(operation.methodUUID)) as V1RawMethodResponse;
  return {
    operation,
    template,
  };
}

export interface ExecuteSqlUpdateResult {
  database: NormalizedSqlDatabase;
  query: string;
  statusCode?: number;
  rowsAffected: number;
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

export async function loadSqlUpdateContext(): Promise<SqlExecutionContext> {
  const operation = await fetchSqlUpdateOperation();
  if (!operation?.methodUUID) {
    throw new CliError("SQL update operation metadata is missing methodUUID.", {
      code: "SQL_UPDATE_METADATA_INVALID",
      details: operation,
    });
  }

  const template = (await fetchRawMethod(operation.methodUUID)) as V1RawMethodResponse;
  return { operation, template };
}

export async function executeSqlUpdate(options: ExecuteSqlReadOptions): Promise<ExecuteSqlUpdateResult> {
  const payload = buildSqlReadPayload({
    template: options.context.template,
    operation: options.context.operation,
    dbAuthId: options.database.id,
    query: options.query,
  });

  const formData = new FormData();
  formData.append("body", JSON.stringify(payload));

  const response = await testMethodMultipart(formData);
  if (!response.ok) {
    throw new CliError(`SQL update execution request failed (${response.status}).`, {
      code: "SQL_UPDATE_EXECUTION_FAILED",
      details: await response.text(),
    });
  }

  const executionResult = (await response.json()) as any;
  const parsed = parseSqlUpdateResult(executionResult);

  if (!parsed.success) {
    const failedService = (executionResult?.services || []).find((svc: any) => svc?.executionStatus?.failed);
    const parsedError = failedService?.executionStatus
      ? ErrorParser.parse(failedService.executionStatus)
      : null;

    throw new CliError("SQL update execution failed.", {
      code: "SQL_UPDATE_QUERY_FAILED",
      details: {
        database: options.database,
        query: options.query,
        statusCode: parsed.statusCode,
        error: parsedError,
        executionStatus: executionResult?.executionStatus,
      },
    });
  }

  const data: ExecuteSqlUpdateResult = {
    database: options.database,
    query: options.query,
    statusCode: parsed.statusCode,
    rowsAffected: parsed.rowsAffected,
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

export interface ExecuteSqlInsertResult {
  database: NormalizedSqlDatabase;
  query: string;
  statusCode?: number;
  rowsAffected: number;
  generatedValues: string[];
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

export async function loadSqlInsertContext(): Promise<SqlExecutionContext> {
  const operation = await fetchSqlInsertOperation();
  if (!operation?.methodUUID) {
    throw new CliError("SQL insert operation metadata is missing methodUUID.", {
      code: "SQL_INSERT_METADATA_INVALID",
      details: operation,
    });
  }

  const template = (await fetchRawMethod(operation.methodUUID)) as V1RawMethodResponse;
  return { operation, template };
}

export async function executeSqlInsert(options: ExecuteSqlReadOptions): Promise<ExecuteSqlInsertResult> {
  const payload = buildSqlReadPayload({
    template: options.context.template,
    operation: options.context.operation,
    dbAuthId: options.database.id,
    query: options.query,
  });

  const formData = new FormData();
  formData.append("body", JSON.stringify(payload));

  const response = await testMethodMultipart(formData);
  if (!response.ok) {
    throw new CliError(`SQL insert execution request failed (${response.status}).`, {
      code: "SQL_INSERT_EXECUTION_FAILED",
      details: await response.text(),
    });
  }

  const executionResult = (await response.json()) as any;
  const parsed = parseSqlInsertResult(executionResult);

  if (!parsed.success) {
    const failedService = (executionResult?.services || []).find((svc: any) => svc?.executionStatus?.failed);
    const parsedError = failedService?.executionStatus
      ? ErrorParser.parse(failedService.executionStatus)
      : null;

    throw new CliError("SQL insert execution failed.", {
      code: "SQL_INSERT_QUERY_FAILED",
      details: {
        database: options.database,
        query: options.query,
        statusCode: parsed.statusCode,
        error: parsedError,
        executionStatus: executionResult?.executionStatus,
      },
    });
  }

  const data: ExecuteSqlInsertResult = {
    database: options.database,
    query: options.query,
    statusCode: parsed.statusCode,
    rowsAffected: parsed.rowsAffected,
    generatedValues: parsed.generatedValues,
    executionTime: parsed.executionTime,
  };

  if (options.raw) {
    data.raw = { operation: options.context.operation, payload, executionResult };
  }

  return data;
}

export interface ExecuteSqlModifyResult {
  database: NormalizedSqlDatabase;
  query: string;
  statusCode?: number;
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

export async function loadSqlModifyContext(): Promise<SqlExecutionContext> {
  const operation = await fetchSqlModifyOperation();
  if (!operation?.methodUUID) {
    throw new CliError("SQL modify operation metadata is missing methodUUID.", {
      code: "SQL_MODIFY_METADATA_INVALID",
      details: operation,
    });
  }

  const template = (await fetchRawMethod(operation.methodUUID)) as V1RawMethodResponse;
  return { operation, template };
}

export async function executeSqlModify(options: ExecuteSqlReadOptions): Promise<ExecuteSqlModifyResult> {
  const payload = buildSqlReadPayload({
    template: options.context.template,
    operation: options.context.operation,
    dbAuthId: options.database.id,
    query: options.query,
  });

  const formData = new FormData();
  formData.append("body", JSON.stringify(payload));

  const response = await testMethodMultipart(formData);
  if (!response.ok) {
    throw new CliError(`SQL modify execution request failed (${response.status}).`, {
      code: "SQL_MODIFY_EXECUTION_FAILED",
      details: await response.text(),
    });
  }

  const executionResult = (await response.json()) as any;
  const parsed = parseSqlModifyResult(executionResult);

  if (!parsed.success) {
    const failedService = (executionResult?.services || []).find((svc: any) => svc?.executionStatus?.failed);
    const parsedError = failedService?.executionStatus
      ? ErrorParser.parse(failedService.executionStatus)
      : null;

    throw new CliError("SQL schema modification failed.", {
      code: "SQL_MODIFY_QUERY_FAILED",
      details: {
        database: options.database,
        query: options.query,
        statusCode: parsed.statusCode,
        error: parsedError,
        executionStatus: executionResult?.executionStatus,
      },
    });
  }

  const data: ExecuteSqlModifyResult = {
    database: options.database,
    query: options.query,
    statusCode: parsed.statusCode,
    executionTime: parsed.executionTime,
  };

  if (options.raw) {
    data.raw = { operation: options.context.operation, payload, executionResult };
  }

  return data;
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

  const response = await testMethodMultipart(formData);
  if (!response.ok) {
    throw new CliError(`SQL execution request failed (${response.status}).`, {
      code: "SQL_EXECUTION_FAILED",
      details: await response.text(),
    });
  }

  const executionResult = (await response.json()) as any;
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
