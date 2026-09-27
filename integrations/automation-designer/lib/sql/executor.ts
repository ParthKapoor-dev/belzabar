import { CliError, Config, loadConfigFileRaw, trustedBelzEnv } from "@belzabar/core";
import { assertReadOnlySql } from "./read-only";
import { ErrorParser } from "../error-parser";
import { fetchRawMethod, testMethodMultipart } from "../api/v1";
import { describeTestFailure } from "../payload-builder";
import type { V1RawMethodResponse } from "../types/v1-wire";
import { fetchSqlDatabases, fetchSqlSelectOperation, fetchSqlUpdateOperation, fetchSqlInsertOperation, fetchSqlModifyOperation, fetchExecutableCategory } from "./api";
import { buildSqlReadPayload } from "./payload";
import {
  insertOutputIds,
  parseMultipleKeysError,
  parseSqlRunResult,
  parseSqlUpdateResult,
  parseSqlInsertResult,
  parseSqlModifyResult,
} from "./result";
import { stripSqlLiterals } from "./read-only";
import { normalizeSqlDatabases, resolveSqlDatabase } from "./selector";
import type {
  NormalizedSqlDatabase,
  SqlSelectOperation,
  SqlDbResolutionResult,
} from "./types";

export const DEFAULT_SQL_DB_FALLBACK = "NSM_Read_DB";

export interface SqlDefaultDb {
  value: string;
  /** "config": `environments.<env>.sqlDefaultDb`; "env": BELZ_SQL_DEFAULT_DB. */
  source: "config" | "env";
}

/**
 * The default SQL database for the active env when `--db` is not given
 * (AD-36 / F26): `environments.<env>.sqlDefaultDb` in ~/.belz/config.json,
 * then BELZ_SQL_DEFAULT_DB (all envs). The hard-coded `NSM_Read_DB` fallback
 * applies after these, and only exists on NSM.
 */
export function sqlDefaultDb(envName: string | undefined = safeActiveEnvName()): SqlDefaultDb | undefined {
  if (envName) {
    const fromConfig = loadConfigFileRaw().environments?.[envName]?.sqlDefaultDb;
    if (typeof fromConfig === "string" && fromConfig.trim()) return { value: fromConfig.trim(), source: "config" };
  }
  const fromEnv = trustedBelzEnv().BELZ_SQL_DEFAULT_DB?.trim();
  return fromEnv ? { value: fromEnv, source: "env" } : undefined;
}

function safeActiveEnvName(): string | undefined {
  try {
    return Config.activeEnv.name;
  } catch {
    return undefined;
  }
}

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
  /** Default when no --db: omit to use {@link sqlDefaultDb} for the active env. */
  envDefault?: SqlDefaultDb;
  fallbackNickname?: string;
}): Promise<SqlDbContext> {
  const rawDatabases = await fetchSqlDatabases();
  const databases = normalizeSqlDatabases(rawDatabases);
  const def = options.envDefault ?? sqlDefaultDb();
  const resolution = resolveSqlDatabase(databases, {
    requested: options.requestedDb,
    envDefault: def?.value,
    envDefaultSource: def?.source,
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
  const fallbackCategory = await fetchExecutableCategory();
  const payload = buildSqlReadPayload({
    template: options.context.template,
    operation: options.context.operation,
    dbAuthId: options.database.id,
    query: options.query,
    fallbackCategory,
  });

  const formData = new FormData();
  formData.append("body", JSON.stringify(payload));

  const response = await testMethodMultipart(formData);
  if (!response.ok) {
    const failure = await describeTestFailure(response);
    throw new CliError(`SQL update execution request failed (${failure.message})`, {
      code: "SQL_UPDATE_EXECUTION_FAILED",
      details: { status: response.status, body: failure.body },
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
  /** Generated key values (F25): needs `RETURNING <key column>` in the query. */
  generatedValues: string[];
  /** Multi-row RETURNING: every returned key row (column → value). */
  generatedKeys?: Array<Record<string, string>>;
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

/** True when the statement has a RETURNING clause (outside literals/comments). */
export function hasReturningClause(query: string): boolean {
  return /\breturning\b/i.test(stripSqlLiterals(query).text);
}

/**
 * Ask the insert step for the generated key (F25): add the operation's
 * `generatedId` output to the target step. The platform fills it from JDBC
 * getGeneratedKeys, which only works with `RETURNING <one column>`.
 */
export function withGeneratedIdOutput(payload: V1RawMethodResponse, operation: unknown): V1RawMethodResponse {
  const ids = insertOutputIds(operation);
  const genId = ids.generated.find((id) => {
    const out = ((operation as any)?.automationAPIOutputs ?? []).find((o: any) => Number(o.id) === id);
    return out?.consumes === "generatedId";
  });
  if (genId === undefined) return payload;
  const inner = JSON.parse(payload.jsonDefinition);
  const services: any[] = Array.isArray(inner?.services) ? inner.services : [];
  const opId = Number((operation as any)?.id);
  const target = services.find((svc) => Number(svc?.automationApiId) === opId) ?? services[0];
  if (!target) return payload;
  target.outputs = Array.isArray(target.outputs) ? target.outputs : [];
  if (!target.outputs.some((o: any) => Number(o?.automationAPIOutputId) === genId)) {
    target.outputs.push({ automationId: null, automationAPIOutputId: genId, code: "generatedId", displayName: "generatedID" });
  }
  return { ...payload, jsonDefinition: JSON.stringify(inner) };
}

function failedServiceMessage(executionResult: any): string {
  const failed = (executionResult?.services || []).find((svc: any) => svc?.executionStatus?.failed);
  const st = failed?.executionStatus ?? executionResult?.executionStatus ?? {};
  for (const v of [st.error, st.message, st.errorMessage]) if (typeof v === "string" && v) return v;
  return "";
}

export async function executeSqlInsert(options: ExecuteSqlReadOptions): Promise<ExecuteSqlInsertResult> {
  const fallbackCategory = await fetchExecutableCategory();
  let payload = buildSqlReadPayload({
    template: options.context.template,
    operation: options.context.operation,
    dbAuthId: options.database.id,
    query: options.query,
    fallbackCategory,
  });
  const returning = hasReturningClause(options.query);
  if (returning) payload = withGeneratedIdOutput(payload, options.context.operation);

  const formData = new FormData();
  formData.append("body", JSON.stringify(payload));

  const response = await testMethodMultipart(formData);
  if (!response.ok) {
    const failure = await describeTestFailure(response);
    throw new CliError(`SQL insert execution request failed (${failure.message})`, {
      code: "SQL_INSERT_EXECUTION_FAILED",
      details: { status: response.status, body: failure.body },
    });
  }

  const executionResult = (await response.json()) as any;
  const parsed = parseSqlInsertResult(executionResult, insertOutputIds(options.context.operation));
  let generatedKeys: Array<Record<string, string>> | undefined;

  if (!parsed.success) {
    // Multi-row RETURNING: the rows ARE committed; the platform only fails to
    // hand back more than one key, and lists them in its error (F25).
    const keys = returning ? parseMultipleKeysError(failedServiceMessage(executionResult)) : null;
    if (keys) {
      generatedKeys = keys;
      parsed.success = true;
      parsed.rowsAffected = keys.length;
      parsed.generatedValues = keys.map((k) => Object.values(k)[0] ?? "");
    }
  }

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
    ...(generatedKeys ? { generatedKeys } : {}),
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
  const fallbackCategory = await fetchExecutableCategory();
  const payload = buildSqlReadPayload({
    template: options.context.template,
    operation: options.context.operation,
    dbAuthId: options.database.id,
    query: options.query,
    fallbackCategory,
  });

  const formData = new FormData();
  formData.append("body", JSON.stringify(payload));

  const response = await testMethodMultipart(formData);
  if (!response.ok) {
    const failure = await describeTestFailure(response);
    throw new CliError(`SQL modify execution request failed (${failure.message})`, {
      code: "SQL_MODIFY_EXECUTION_FAILED",
      details: { status: response.status, body: failure.body },
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
  // F2: the read endpoint autocommits, so a write here really happens.
  assertReadOnlySql(options.query);
  const fallbackCategory = await fetchExecutableCategory();
  const payload = buildSqlReadPayload({
    template: options.context.template,
    operation: options.context.operation,
    dbAuthId: options.database.id,
    query: options.query,
    fallbackCategory,
  });

  const formData = new FormData();
  formData.append("body", JSON.stringify(payload));

  const response = await testMethodMultipart(formData);
  if (!response.ok) {
    const failure = await describeTestFailure(response);
    throw new CliError(`SQL execution request failed (${failure.message})`, {
      code: "SQL_EXECUTION_FAILED",
      details: { status: response.status, body: failure.body },
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
