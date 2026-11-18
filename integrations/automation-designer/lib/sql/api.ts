import { apiFetch, ensureApiOk, expectFound, readJsonOrNull } from "@belzabar/core";
import type { ExecutableCategoryLookup, SqlDatabaseAuth, SqlSelectOperation, SqlUpdateOperation, SqlInsertOperation, SqlModifyOperation } from "./types";

export async function fetchSqlDatabases(): Promise<SqlDatabaseAuth[]> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/auth", {
    method: "GET",
    authMode: "Bearer",
  });

  await ensureApiOk(response, { code: "SQL_DATABASES_FETCH_FAILED", message: (res) => `Failed to fetch SQL databases (${res.status})` });

  return expectFound(await readJsonOrNull<SqlDatabaseAuth[]>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

export async function fetchSqlSelectOperation(): Promise<SqlSelectOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/select", {
    method: "GET",
    authMode: "Bearer",
  });

  await ensureApiOk(response, { code: "SQL_SELECT_METADATA_FETCH_FAILED", message: (res) => `Failed to fetch SQL read operation metadata (${res.status})` });

  return expectFound(await readJsonOrNull<SqlSelectOperation>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

export async function fetchSqlUpdateOperation(): Promise<SqlUpdateOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/update", {
    method: "GET",
    authMode: "Bearer",
  });

  await ensureApiOk(response, { code: "SQL_UPDATE_METADATA_FETCH_FAILED", message: (res) => `Failed to fetch SQL update operation metadata (${res.status})` });

  return expectFound(await readJsonOrNull<SqlUpdateOperation>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

export async function fetchSqlInsertOperation(): Promise<SqlInsertOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/insert", {
    method: "GET",
    authMode: "Bearer",
  });

  await ensureApiOk(response, { code: "SQL_INSERT_METADATA_FETCH_FAILED", message: (res) => `Failed to fetch SQL insert operation metadata (${res.status})` });

  return expectFound(await readJsonOrNull<SqlInsertOperation>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

export async function fetchSqlModifyOperation(): Promise<SqlModifyOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/modify", {
    method: "GET",
    authMode: "Bearer",
  });

  await ensureApiOk(response, { code: "SQL_MODIFY_METADATA_FETCH_FAILED", message: (res) => `Failed to fetch SQL modify operation metadata (${res.status})` });

  return expectFound(await readJsonOrNull<SqlModifyOperation>(response), { notFoundCode: "SQL_EMPTY_RESPONSE", notFoundMessage: "The db_service endpoint answered with an empty body." });
}

let executableCategoryCache: Promise<ExecutableCategoryLookup> | null = null;
let categoryRetryDelayMs = 1500;

/** Test-only: clears the per-process executable-category cache (and sets the retry delay). */
export function resetExecutableCategoryCache(opts: { retryDelayMs?: number } = {}): void {
  executableCategoryCache = null;
  categoryRetryDelayMs = opts.retryDelayMs ?? 1500;
}

/**
 * Resolve a category that exists on the connected env and that the current user
 * is allowed to execute, so the synthetic SQL test chain passes the server's
 * AuthorizeExecution check. The server only needs a real category *id* (the name
 * is cosmetic); any PUBLIC category works. Prefer a "Helpers"-style one for
 * stability, else the lowest-id PUBLIC category.
 *
 * A lookup that gives nothing (an HTTP error, or no PUBLIC category in the
 * answer) is retried once: it was seen to fail once on an env where it worked
 * seconds later. Only a found category is cached per process. With none, the
 * caller fails with SQL_NO_EXECUTABLE_CATEGORY unless the template carries
 * its own category, and `failure` says why.
 */
export async function fetchExecutableCategory(): Promise<ExecutableCategoryLookup> {
  if (executableCategoryCache) return executableCategoryCache;

  const attempt = (async (): Promise<ExecutableCategoryLookup> => {
    const first = await lookupExecutableCategory();
    if (first.category) return first;
    await new Promise((r) => setTimeout(r, categoryRetryDelayMs));
    const second = await lookupExecutableCategory();
    return second.category ? second : { category: null, failure: `${second.failure ?? first.failure} (tried twice)` };
  })();
  executableCategoryCache = attempt;
  attempt.then(
    (r) => {
      if (!r.category && executableCategoryCache === attempt) executableCategoryCache = null;
    },
    () => {
      if (executableCategoryCache === attempt) executableCategoryCache = null;
    },
  );
  return attempt;
}

async function lookupExecutableCategory(): Promise<ExecutableCategoryLookup> {
  // fetchSystemServices=false returns AutomationChainCategory rows whose `id`
  // is the chain-category id the server resolves in AuthorizeExecution. The
  // =true variant returns automation *systems* (a different id space), whose
  // ids may not resolve to a category — that's what caused the original NPE.
  let response: Response;
  try {
    response = await apiFetch("/rest/api/automation/chain/category?fetchSystemServices=false", {
      method: "GET",
      authMode: "Bearer",
    });
  } catch (e) {
    return { category: null, failure: `the category lookup failed (${(e as Error).message})` };
  }

  if (!response.ok) return { category: null, failure: `the category lookup answered HTTP ${response.status}` };

  const body = await readJsonOrNull<unknown>(response).catch(() => null);
  const list: any[] = Array.isArray(body)
    ? body
    : ((body as any)?.content ?? (body as any)?.data ?? []);

  const publics = list.filter(
    (c) => typeof c?.id === "number" && String(c?.accessMode).toUpperCase() === "PUBLIC"
  );
  if (publics.length === 0) return { category: null, failure: `the category lookup listed no PUBLIC category (${list.length} categories)` };

  const helper = publics.find((c) => String(c?.name ?? "").toLowerCase().includes("helper"));
  const chosen = helper ?? [...publics].sort((a, b) => a.id - b.id)[0];

  return { category: { id: chosen.id as number, name: String(chosen.name ?? "") } };
}
