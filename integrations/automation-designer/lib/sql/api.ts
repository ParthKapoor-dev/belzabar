import { apiFetch, CliError, expectFound, readErrorBody, readJsonOrNull } from "@belzabar/core";
import type { ExecutableCategoryRef, SqlDatabaseAuth, SqlSelectOperation, SqlUpdateOperation, SqlInsertOperation, SqlModifyOperation } from "./types";

export async function fetchSqlDatabases(): Promise<SqlDatabaseAuth[]> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/auth", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL databases (${response.status})`, {
      code: "SQL_DATABASES_FETCH_FAILED",
      details: { status: response.status, body: await readErrorBody(response) },
    });
  }

  return expectFound(await readJsonOrNull<SqlDatabaseAuth[]>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

export async function fetchSqlSelectOperation(): Promise<SqlSelectOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/select", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL read operation metadata (${response.status})`, {
      code: "SQL_SELECT_METADATA_FETCH_FAILED",
      details: { status: response.status, body: await readErrorBody(response) },
    });
  }

  return expectFound(await readJsonOrNull<SqlSelectOperation>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

export async function fetchSqlUpdateOperation(): Promise<SqlUpdateOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/update", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL update operation metadata (${response.status})`, {
      code: "SQL_UPDATE_METADATA_FETCH_FAILED",
      details: { status: response.status, body: await readErrorBody(response) },
    });
  }

  return expectFound(await readJsonOrNull<SqlUpdateOperation>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

export async function fetchSqlInsertOperation(): Promise<SqlInsertOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/insert", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL insert operation metadata (${response.status})`, {
      code: "SQL_INSERT_METADATA_FETCH_FAILED",
      details: { status: response.status, body: await readErrorBody(response) },
    });
  }

  return expectFound(await readJsonOrNull<SqlInsertOperation>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

export async function fetchSqlModifyOperation(): Promise<SqlModifyOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/modify", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL modify operation metadata (${response.status})`, {
      code: "SQL_MODIFY_METADATA_FETCH_FAILED",
      details: { status: response.status, body: await readErrorBody(response) },
    });
  }

  return expectFound(await readJsonOrNull<SqlModifyOperation>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

let executableCategoryCache: Promise<ExecutableCategoryRef | null> | null = null;

/** Test-only: clears the per-process executable-category cache. */
export function resetExecutableCategoryCache(): void {
  executableCategoryCache = null;
}

/**
 * Resolve a category that exists on the connected env and that the current user
 * is allowed to execute, so the synthetic SQL test chain passes the server's
 * AuthorizeExecution check. The server only needs a real category *id* (the name
 * is cosmetic); any PUBLIC category works. Prefer a "Helpers"-style one for
 * stability, else the lowest-id PUBLIC category. Cached per process; returns
 * null if the lookup fails (the caller then fails with SQL_NO_EXECUTABLE_CATEGORY
 * unless the template carries its own category).
 */
export async function fetchExecutableCategory(): Promise<ExecutableCategoryRef | null> {
  if (executableCategoryCache) return executableCategoryCache;

  executableCategoryCache = (async () => {
    // fetchSystemServices=false returns AutomationChainCategory rows whose `id`
    // is the chain-category id the server resolves in AuthorizeExecution. The
    // =true variant returns automation *systems* (a different id space), whose
    // ids may not resolve to a category — that's what caused the original NPE.
    const response = await apiFetch("/rest/api/automation/chain/category?fetchSystemServices=false", {
      method: "GET",
      authMode: "Bearer",
    });

    if (!response.ok) return null;

    const body = await readJsonOrNull<unknown>(response);
    const list: any[] = Array.isArray(body)
      ? body
      : ((body as any)?.content ?? (body as any)?.data ?? []);

    const publics = list.filter(
      (c) => typeof c?.id === "number" && String(c?.accessMode).toUpperCase() === "PUBLIC"
    );
    if (publics.length === 0) return null;

    const helper = publics.find((c) => String(c?.name ?? "").toLowerCase().includes("helper"));
    const chosen = helper ?? [...publics].sort((a, b) => a.id - b.id)[0];

    return { id: chosen.id as number, name: String(chosen.name ?? "") };
  })();

  return executableCategoryCache;
}
