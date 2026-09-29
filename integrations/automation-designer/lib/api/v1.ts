// V1 Automation Designer HTTP client.
//
// This module knows the V1 REST surface and returns typed wire responses.
// Parsing (with the service resolver, AD-02) is adApi.fetchMethod's job:
// a V1 body parsed without it misclassifies SQL / echo steps. Prefer
// lib/api/index.ts:adApi; a few callers need the raw wire directly.

import { apiFetch, CliError, Config, expectJson, readErrorBody, readJsonOrNull, redactSecrets, redactString } from "@belzabar/core";
import type { V1AutomationDefinition, V1RawMethodResponse } from "../types/v1-wire";

/**
 * Per-call timeout for long server-side operations (`/chain/test`, execute,
 * publish, history restore, test suites). The core default (60 s to headers)
 * is too short for heavy chains, and a timed-out POST may still complete on
 * the server, so retries can double-apply.
 */
export const AD_LONG_OP_TIMEOUT_MS = 10 * 60_000;

// ─── Error envelope used by every V1 request ────────────────────────────

async function checkResponse(response: Response, path: string): Promise<void> {
  if (response.ok) return;
  // Small JSON stays structured; anything else is summarised (HTML → title). Redacted.
  const details = await readErrorBody(response);
  const code = response.status === 409 ? "AD_VERSION_CONFLICT" : "AD_API_ERROR";
  throw new CliError(`${response.status} ${response.statusText} on ${path}`, {
    code,
    details: { path, status: response.status, body: details },
  });
}

/**
 * Check the status, then parse the body. A 2xx with an empty (or `null`) body
 * resolves to `null` instead of throwing a raw `JSON Parse error` (the suite
 * GET answers a method with no test suite with 200 + empty body); a non-JSON
 * body is HTTP_BAD_JSON. Every V1 read/write goes through this.
 */
async function readJson<T = unknown>(response: Response, path: string): Promise<T | null> {
  await checkResponse(response, path);
  return readJsonOrNull<T>(response, { path });
}

/**
 * Parse a chain GET. 404 — and 200 with an empty/`null` body, which is how
 * the server answers an unknown uuid (AD-11 / F10) — are METHOD_NOT_FOUND.
 */
async function fetchChainJson<T>(response: Response, path: string, uuid: string): Promise<T> {
  if (response.ok || response.status === 404) {
    return expectJson<T>(response, {
      path,
      notFoundCode: "METHOD_NOT_FOUND",
      notFoundMessage: `Method not found: ${uuid}`,
      details: { uuid },
    });
  }
  await checkResponse(response, path);
  throw new Error("unreachable");
}

// ─── READS ───────────────────────────────────────────────────────────────

export async function fetchRawMethod(uuid: string): Promise<V1RawMethodResponse> {
  const path = `/rest/api/automation/chain/${uuid}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return fetchChainJson<V1RawMethodResponse>(response, path, uuid);
}

export async function fetchAutomationDefinition(
  automationId: string,
): Promise<V1AutomationDefinition | null> {
  const path = `/rest/api/automations/${automationId}?basicinfo=false`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  if (!response.ok) return null;
  return readJsonOrNull<V1AutomationDefinition>(response, { path });
}

export async function listCategories(opts: { includeSystem?: boolean } = {}): Promise<unknown> {
  const flag = opts.includeSystem ? "true" : "false";
  const path = `/rest/api/automation/chain/category?fetchSystemServices=${flag}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return readJson(response, path);
}

export async function listServices(opts: { limit?: number; offset?: number } = {}): Promise<unknown> {
  const limit = opts.limit ?? 2000;
  const offset = opts.offset ?? 0;
  const path = `/rest/api/automation/services?limit=${limit}&offset=${offset}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return readJson(response, path);
}

export async function fetchChildMethodInfo(
  category: string,
  methodName: string,
): Promise<unknown> {
  const path = `/rest/api/automation-systems/${encodeURIComponent(category)}/automation-apis/${encodeURIComponent(methodName)}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return readJson(response, path);
}

/** A service's (automation system's) methods: `GET /automation-systems/{svc}/automation-apis`. Unknown service → []. */
export async function listServiceMethods(service: string): Promise<unknown> {
  const path = `/rest/api/automation-systems/${encodeURIComponent(service)}/automation-apis`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return readJson(response, path);
}

export async function exportMethod(methodId: string | number): Promise<unknown> {
  const path = `/rest/api/automation/chain/export/${methodId}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return readJson(response, path);
}

export async function exportCategory(categoryId: string | number): Promise<unknown> {
  const path = `/rest/api/automation/chain/export/category/${categoryId}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return readJson(response, path);
}

export async function listTestCases(chainUuid: string): Promise<unknown> {
  const path = `/rest/api/automation/chain/testsuite/service-chain/${chainUuid}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return readJson(response, path);
}

export async function getTestSuiteReport(): Promise<unknown> {
  const path = `/rest/api/automation/chain/testsuite/report`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return readJson(response, path);
}

// ─── WRITES ──────────────────────────────────────────────────────────────

export async function publishDraft(draftUuid: string): Promise<{ publishedUuid: string }> {
  const path = `/rest/api/automation/chain/${draftUuid}/publish`;
  const response = await apiFetch(path, {
    method: "POST",
    timeoutMs: AD_LONG_OP_TIMEOUT_MS,
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
  });
  const body = await readJson<{ referenceId?: string }>(response, path);
  if (!body?.referenceId) {
    throw new CliError("Publish response missing referenceId", {
      code: "AD_PUBLISH_INVALID_RESPONSE",
      details: { path, body },
    });
  }
  return { publishedUuid: body.referenceId };
}

export async function createCategory(body: Record<string, unknown>): Promise<unknown> {
  const path = `/rest/api/automation/chain/category`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response, path);
}

export async function importMethods(payload: unknown): Promise<unknown> {
  const path = `/rest/api/automation/chain/import`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJson(response, path);
}

export async function createTestCase(chainUuid: string, body: unknown): Promise<unknown> {
  const path = `/rest/api/automation/chain/testcases/${chainUuid}`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response, path);
}

export async function updateTestCase(
  chainUuid: string,
  testCaseId: string,
  body: unknown,
): Promise<unknown> {
  const path = `/rest/api/automation/chain/testcases/${chainUuid}/${testCaseId}`;
  const response = await apiFetch(path, {
    method: "PUT",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response, path);
}

export async function deleteTestCase(testCaseId: string): Promise<void> {
  const path = `/rest/api/automation/chain/testcases/${testCaseId}`;
  const response = await apiFetch(path, { method: "DELETE", authMode: "Bearer" });
  await checkResponse(response, path);
}

export async function bulkCreateTestCases(
  chainUuid: string,
  cases: unknown[],
): Promise<unknown> {
  const path = `/rest/api/automation/chain/testcases/bulk/${chainUuid}`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cases),
  });
  return readJson(response, path);
}

export async function runTestSuite(chainUuid: string): Promise<unknown> {
  const path = `/rest/api/automation/chain/testsuite/execute`;
  const response = await apiFetch(path, {
    method: "POST",
    timeoutMs: AD_LONG_OP_TIMEOUT_MS,
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chainUuid }),
  });
  return readJson(response, path);
}

export async function deleteTestSuite(testSuiteId: string): Promise<void> {
  const path = `/rest/api/automation/chain/testsuite/${testSuiteId}`;
  const response = await apiFetch(path, { method: "DELETE", authMode: "Bearer" });
  await checkResponse(response, path);
}

/**
 * Low-level multipart POST to the V1 test endpoint. Used by the SQL module
 * which builds hand-crafted FormData bodies wrapping a SQL template method.
 * Build the body with lib/payload-builder.ts:buildV1TestPayload (the one
 * V1 test payload builder, AD-38).
 */
export async function testMethodMultipart(formData: FormData): Promise<Response> {
  const path = "/rest/api/automation/chain/test";
  const response = await apiFetch(path, {
    method: "POST",
    timeoutMs: AD_LONG_OP_TIMEOUT_MS,
    authMode: "Bearer",
    headers: {
      "internal-ad-execution-mode": "debug",
      "Expertly-Auth-Token": "true",
    },
    body: formData,
  });
  return redactTestResponse(response);
}

/**
 * Debug-mode test responses echo the request headers, including
 * `Authorization: Bearer <jwt>` and `Expertly-Auth-Token` (ad-validation §1.7).
 * Re-wrap the response with those scrubbed so no caller can print or cache them.
 */
async function redactTestResponse(response: Response): Promise<Response> {
  const text = await response.text();
  let body: string;
  try {
    body = JSON.stringify(redactSecrets(JSON.parse(text), { keys: "headers" }));
  } catch {
    body = redactString(text);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length"); // body length changed
  headers.delete("content-encoding"); // already decoded
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// ─── METHOD HISTORY (via published internal services) ────────────────────

// The published UUIDs of the Expertly.Automation.Method.History service
// methods are environment-specific. We discover them at runtime via the
// child-info endpoint and cache them for the lifetime of the process.
const HISTORY_SERVICE_CATEGORY = "Expertly.Automation.Method.History";

// Keyed `${env}:${methodName}` — `trace` switches env in-process, and each env
// has its own published History uuids.
const _historyUuidCache: Record<string, string> = {};

/** Cache key for {@link resolveHistoryMethodUuid}: env-scoped. */
export function historyUuidCacheKey(env: string | undefined, methodName: string): string {
  return `${env ?? "default"}:${methodName}`;
}

async function resolveHistoryMethodUuid(methodName: string): Promise<string> {
  const cacheKey = historyUuidCacheKey(Config.activeEnv?.name, methodName);
  if (_historyUuidCache[cacheKey]) return _historyUuidCache[cacheKey]!;

  const info = await fetchChildMethodInfo(HISTORY_SERVICE_CATEGORY, methodName);
  const body = (info ?? {}) as Record<string, unknown>;
  const uid =
    (typeof body.serviceChainUID === "string" && body.serviceChainUID) ||
    (typeof body.methodUUID === "string" && body.methodUUID);
  if (!uid) {
    throw new CliError(
      `Could not resolve published UUID for ${HISTORY_SERVICE_CATEGORY}.${methodName} in this environment.`,
      { code: "HISTORY_SERVICE_NOT_FOUND", details: { methodName, body } },
    );
  }
  _historyUuidCache[cacheKey] = uid;
  return uid;
}

export interface MethodVersionSummary {
  methodVersionID: string;
  methodVersion: number;
  methodID: string;
  isPublished: boolean;
  isDeactivated: boolean;
  addedBy: number;
  addedWhen: string;
}

export interface MethodVersionFull extends MethodVersionSummary {
  jsonDefinition: unknown;
}

/**
 * List all saved versions of a method. Calls the published
 * Expertly.Automation.Method.History.listAll service.
 */
export async function historyListAll(
  methodUUID: string,
  opts?: { includeDraft?: boolean },
): Promise<MethodVersionSummary[]> {
  const payload: Record<string, unknown> = { methodUUID };
  if (opts?.includeDraft) payload.includeDraft = "true";

  const publishedUuid = await resolveHistoryMethodUuid("listAll");
  const path = `/rest/api/automation/chain/execute/${publishedUuid}?encrypted=true`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Raw",
    body: JSON.stringify(payload),
  });

  if (!response.ok) await throwHistoryError(response, "listAll");

  const body = await readJsonOrNull<Record<string, unknown>>(response, { path });
  if (!body) return [];
  const items = extractHistoryResponse(body);
  if (!Array.isArray(items)) return [];

  return items.map(normalizeVersionSummary);
}

/**
 * Fetch a specific version's full body (including jsonDefinition). Calls the
 * published Expertly.Automation.Method.History.get service.
 *
 * The get endpoint requires `serviceName` + `methodName` + `version` (passing
 * only `methodUUID` + `version` via the execute endpoint results in a 500).
 * Callers should pass `category` (the service/category name) and `methodName`.
 *
 * F7: `includeDraft: true` selects the DRAFT chain's history, otherwise the
 * PUBLISHED chain's. The two chains keep independent version counters, so
 * the caller must pick the side that matches the uuid it listed
 * (`listAll` lists by `methodUUID`, i.e. exactly the chain it is given).
 */
export async function historyGet(opts: {
  category: string;
  methodName: string;
  version: number;
  includeDraft?: boolean;
}): Promise<MethodVersionFull> {
  const payload: Record<string, unknown> = {
    serviceName: opts.category,
    methodName: opts.methodName,
    version: String(opts.version),
  };
  if (opts.includeDraft) payload.includeDraft = "true";

  const publishedUuid = await resolveHistoryMethodUuid("get");
  const path = `/rest/api/automation/chain/execute/${publishedUuid}?encrypted=true`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Raw",
    body: JSON.stringify(payload),
  });

  if (!response.ok) await throwHistoryError(response, "get", opts.version);

  const body = await readJsonOrNull<Record<string, unknown>>(response, { path });
  if (!body) {
    throw new CliError(`History version ${opts.version} returned an empty body.`, {
      code: "HISTORY_VERSION_NOT_FOUND",
      details: { version: opts.version, methodName: opts.methodName },
    });
  }
  const inner = extractHistoryResponseSingle(body);

  return {
    ...normalizeVersionSummary(inner),
    jsonDefinition: inner.jsonDefinition,
  };
}

/**
 * Restore a method to a previous version. Calls the published
 * Expertly.Automation.Method.History.restore service.
 *
 * `includeDraft: true` restores the DRAFT chain named by category+methodName
 * (`version` is a draft-history version); without it the PUBLISHED chain is
 * restored — callers must never do that (the command goes through the draft
 * guard). Live wire: `{response: true, executionStatus: {...}}` on
 * success, HTTP 500 `EEException: No record found.` for an unknown version.
 *
 * Returns `true` / `false` for a recognised answer and `null` when the
 * response shape is not recognised (fail closed, AD-23: never assume success).
 */
export async function historyRestore(opts: {
  category: string;
  methodName: string;
  version: number;
  includeDraft?: boolean;
}): Promise<boolean | null> {
  const payload: Record<string, unknown> = {
    serviceName: opts.category,
    methodName: opts.methodName,
    version: String(opts.version),
  };
  if (opts.includeDraft) payload.includeDraft = "true";

  const publishedUuid = await resolveHistoryMethodUuid("restore");
  const path = `/rest/api/automation/chain/execute/${publishedUuid}?encrypted=true`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Raw",
    body: JSON.stringify(payload),
    timeoutMs: AD_LONG_OP_TIMEOUT_MS,
  });

  if (!response.ok) await throwHistoryError(response, "restore", opts.version);

  const body = await readJsonOrNull<Record<string, unknown>>(response, { path }).catch(() => null);
  return interpretRestoreResponse(body);
}

/** Map a history.restore execute body to true / false / null (unrecognised). Exported for tests. */
export function interpretRestoreResponse(body: unknown): boolean | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const status = b.executionStatus as Record<string, unknown> | undefined;
  if (status && status.failed === true) return false;
  const asBool = (v: unknown): boolean | null =>
    v === true || v === "true" ? true : v === false || v === "false" ? false : null;
  const direct = asBool(b.response);
  if (direct !== null) return direct;
  if (b.response && typeof b.response === "object" && !Array.isArray(b.response)) {
    return asBool((b.response as Record<string, unknown>).response);
  }
  return null;
}

/**
 * History execute calls answer an unknown version with HTTP 500
 * `EEException: No record found.` — map that to HISTORY_VERSION_NOT_FOUND.
 */
async function throwHistoryError(response: Response, op: "get" | "restore" | "listAll", version?: number): Promise<never> {
  const text = await response.text().catch(() => "");
  let message = "";
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    message = String(j.errorMessage ?? j.message ?? "");
  } catch {
    message = redactString(text).slice(0, 300);
  }
  if (/no record found/i.test(message)) {
    throw new CliError(`History version ${version ?? "?"} not found for this method.`, {
      code: "HISTORY_VERSION_NOT_FOUND",
      details: { op, version, status: response.status, message },
    });
  }
  const code = op === "get" ? "HISTORY_GET_FAILED" : op === "restore" ? "HISTORY_RESTORE_FAILED" : "HISTORY_LIST_FAILED";
  throw new CliError(`History ${op} failed: ${response.status}${message ? ` — ${message}` : ""}`, {
    code,
    details: { op, version, status: response.status, message },
  });
}

// Unwrap the standard execute response wrapper
function extractHistoryResponse(body: Record<string, unknown>): unknown[] {
  // The execute endpoint wraps: { response: [...], executionStatus: {...} }
  const resp = body.response;
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === "object") {
    const inner = (resp as Record<string, unknown>).response;
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

function extractHistoryResponseSingle(body: Record<string, unknown>): Record<string, unknown> {
  // The execute endpoint wraps the result: the outermost object has
  // `executionStatus` + the actual version fields at the same level. If
  // there's a `response` wrapper we unwrap one level; otherwise the body
  // itself IS the version object (it will have `methodVersionID`, etc.).
  if (body.methodVersionID || body.methodVersion != null) {
    return body;
  }
  const resp = body.response;
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    const r = resp as Record<string, unknown>;
    if (r.methodVersionID || r.methodVersion != null) {
      return r;
    }
    const inner = r.response;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
    return r;
  }
  throw new CliError("Unexpected history get response shape", {
    code: "HISTORY_GET_INVALID_RESPONSE",
    details: body,
  });
}

function normalizeVersionSummary(raw: unknown): MethodVersionSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    methodVersionID: typeof r.methodVersionID === "string" ? r.methodVersionID : "",
    methodVersion: typeof r.methodVersion === "number" ? r.methodVersion : 0,
    methodID: typeof r.methodID === "string" ? r.methodID : "",
    isPublished: r.isPublished === true,
    isDeactivated: r.isDeactivated === true,
    addedBy: typeof r.addedBy === "number" ? r.addedBy : 0,
    addedWhen: typeof r.addedWhen === "string" ? r.addedWhen : "",
  };
}
