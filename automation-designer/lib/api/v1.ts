// V1 Automation Designer HTTP client.
//
// This module knows the V1 REST surface. It returns either a HydratedMethod
// (for fetch) or typed wire responses (for list/publish/etc). No command
// should import this file directly — use lib/api/index.ts:adApi.

import { apiFetch, CliError } from "@belzabar/core";
import { parseV1Method } from "../parser/v1";
import type { HydratedMethod, ParsedStep } from "../types/common";
import type {
  V1AutomationDefinition,
  V1RawMethodResponse,
  V1SavePayload,
} from "../types/v1-wire";
import { detectJavaException } from "../error-parser";

// ─── Error envelope used by every V1 request ────────────────────────────

async function checkResponse(response: Response, path: string): Promise<void> {
  if (response.ok) return;
  let details: unknown;
  try {
    const text = await response.text();
    try {
      details = JSON.parse(text);
    } catch {
      details = text.slice(0, 1024);
    }
  } catch {
    details = "(response body unreadable)";
  }
  const code = response.status === 409 ? "AD_VERSION_CONFLICT" : "AD_API_ERROR";
  throw new CliError(`${response.status} ${response.statusText} on ${path}`, {
    code,
    details: { path, status: response.status, body: details },
  });
}

// ─── READS ───────────────────────────────────────────────────────────────

export async function fetchMethod(uuid: string): Promise<HydratedMethod> {
  const path = `/rest/api/automation/chain/${uuid}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  if (response.status === 404) {
    throw new CliError("404 Chain Not Found", { code: "METHOD_NOT_FOUND", details: { path } });
  }
  await checkResponse(response, path);
  const raw = (await response.json()) as V1RawMethodResponse;
  return parseV1Method(raw);
}

export async function fetchRawMethod(uuid: string): Promise<V1RawMethodResponse> {
  const path = `/rest/api/automation/chain/${uuid}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  if (response.status === 404) {
    throw new CliError("404 Chain Not Found", { code: "METHOD_NOT_FOUND", details: { path } });
  }
  await checkResponse(response, path);
  return (await response.json()) as V1RawMethodResponse;
}

export async function fetchAutomationDefinition(
  automationId: string,
): Promise<V1AutomationDefinition | null> {
  const path = `/rest/api/automations/${automationId}?basicinfo=false`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  if (!response.ok) return null;
  return (await response.json()) as V1AutomationDefinition;
}

export async function listCategories(opts: { includeSystem?: boolean } = {}): Promise<unknown> {
  const flag = opts.includeSystem ? "true" : "false";
  const path = `/rest/api/automation/chain/category?fetchSystemServices=${flag}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  return await response.json();
}

export async function listServices(opts: { limit?: number; offset?: number } = {}): Promise<unknown> {
  const limit = opts.limit ?? 2000;
  const offset = opts.offset ?? 0;
  const path = `/rest/api/automation/services?limit=${limit}&offset=${offset}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  return await response.json();
}

export async function fetchChildMethodInfo(
  category: string,
  methodName: string,
): Promise<unknown> {
  const path = `/rest/api/automation-systems/${encodeURIComponent(category)}/automation-apis/${encodeURIComponent(methodName)}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  return await response.json();
}

export async function exportMethod(methodId: string | number): Promise<unknown> {
  const path = `/rest/api/automation/chain/export/${methodId}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  return await response.json();
}

export async function exportCategory(categoryId: string | number): Promise<unknown> {
  const path = `/rest/api/automation/chain/export/category/${categoryId}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  return await response.json();
}

export async function listTestCases(chainUuid: string): Promise<unknown> {
  const path = `/rest/api/automation/chain/testsuite/service-chain/${chainUuid}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  return await response.json();
}

export async function fetchTestSuite(testSuiteId: string): Promise<unknown> {
  const path = `/rest/api/automation/chain/testsuite/${testSuiteId}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  return await response.json();
}

export async function getTestSuiteReport(): Promise<unknown> {
  const path = `/rest/api/automation/chain/testsuite/report`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  return await response.json();
}

// ─── WRITES ──────────────────────────────────────────────────────────────

export interface SaveMethodResult {
  /** Server response body after save. */
  response: V1RawMethodResponse;
  /** Re-fetched method so callers can test against server-assigned IDs. */
  method: HydratedMethod;
}

export async function saveMethod(payload: V1SavePayload): Promise<SaveMethodResult> {
  const path = `/rest/api/automation/chain`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await checkResponse(response, path);
  const saved = (await response.json()) as V1RawMethodResponse;
  // Per ad-rest-api-crud-and-testing.md §"Why fetch after create": the server
  // assigns automationId values to each existingService step on save. We must
  // re-fetch so downstream testing works.
  const method = await fetchMethod(saved.uuid);
  return { response: saved, method };
}

export async function publishDraft(draftUuid: string): Promise<{ publishedUuid: string }> {
  const path = `/rest/api/automation/chain/${draftUuid}/publish`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
  });
  await checkResponse(response, path);
  const body = (await response.json()) as { referenceId?: string };
  if (!body.referenceId) {
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
  await checkResponse(response, path);
  return await response.json();
}

export async function importMethods(payload: unknown): Promise<unknown> {
  const path = `/rest/api/automation/chain/import`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await checkResponse(response, path);
  return await response.json();
}

export async function createTestCase(chainUuid: string, body: unknown): Promise<unknown> {
  const path = `/rest/api/automation/chain/testcases/${chainUuid}`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await checkResponse(response, path);
  return await response.json();
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
  await checkResponse(response, path);
  return await response.json();
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
  await checkResponse(response, path);
  return await response.json();
}

export async function runTestSuite(chainUuid: string): Promise<unknown> {
  const path = `/rest/api/automation/chain/testsuite/execute`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chainUuid }),
  });
  await checkResponse(response, path);
  return await response.json();
}

export async function deleteTestSuite(testSuiteId: string): Promise<void> {
  const path = `/rest/api/automation/chain/testsuite/${testSuiteId}`;
  const response = await apiFetch(path, { method: "DELETE", authMode: "Bearer" });
  await checkResponse(response, path);
}

/**
 * Low-level multipart POST to the V1 test endpoint. Used by the SQL module
 * which builds hand-crafted FormData bodies wrapping a SQL template method.
 * Most callers should use testExecuteV1() below instead.
 */
export async function testMethodMultipart(formData: FormData): Promise<Response> {
  const path = "/rest/api/automation/chain/test";
  return apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: {
      "internal-ad-execution-mode": "debug",
      "Expertly-Auth-Token": "true",
    },
    body: formData,
  });
}

// ─── TEST EXECUTE (V1 — test-before-save) ───────────────────────────────

export interface V1TestExecuteResult {
  success: boolean;
  failedStepIndex: number | null;
  raw: unknown;
}

/**
 * Execute a method via the V1 test endpoint. The full modified jsonDefinition
 * is sent as a multipart `body=<compact JSON>` field; the server returns rich
 * per-step trace as JSON. belz's `test` command consumes this.
 *
 * The caller is responsible for injecting testValues / automationApiIds into
 * the method before calling this. `method` must be a V1-sourced HydratedMethod
 * so that `method.raw.jsonDefinition` round-trips correctly.
 */
export async function testExecuteV1(method: HydratedMethod): Promise<V1TestExecuteResult> {
  const raw = method.raw as V1RawMethodResponse;
  const innerDef: Record<string, unknown> = JSON.parse(raw.jsonDefinition);

  // Patch testValue from method.inputs onto inner inputs.
  if (Array.isArray(innerDef.inputs)) {
    const byCode = new Map<string, Record<string, unknown>>();
    for (const f of innerDef.inputs as Record<string, unknown>[]) {
      if (typeof f.fieldCode === "string") byCode.set(f.fieldCode, f);
    }
    for (const mf of method.inputs) {
      if (mf.testValue === undefined) continue;
      const target = byCode.get(mf.code);
      if (target) target.testValue = mf.testValue;
    }
  }

  const payload = {
    category: raw.category,
    jsonDefinition: JSON.stringify(innerDef),
    id: raw.id,
    uuid: raw.uuid,
    version: raw.version,
  };

  const formData = new FormData();
  formData.append("body", JSON.stringify(payload));

  const path = `/rest/api/automation/chain/test`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: {
      "internal-ad-execution-mode": "debug",
      "Expertly-Auth-Token": "true",
    },
    body: formData,
  });
  if (!response.ok) {
    throw new CliError(`Execution failed: ${response.status} ${response.statusText}`, {
      code: "TEST_EXECUTION_FAILED",
      details: await response.text(),
    });
  }

  const result = (await response.json()) as Record<string, unknown>;

  const javaExc = detectJavaException(result);
  if (javaExc) {
    throw new CliError(javaExc.message, {
      code: "BACKEND_COMPILATION_ERROR",
      details: javaExc,
    });
  }

  const services = Array.isArray(result.services) ? (result.services as Record<string, unknown>[]) : [];
  const failedStepIndex = services.findIndex(s => (s.executionStatus as Record<string, unknown>)?.failed);
  const execFailed = (result.executionStatus as Record<string, unknown>)?.failed === true;

  return {
    success: !execFailed,
    failedStepIndex: failedStepIndex >= 0 ? failedStepIndex : null,
    raw: result,
  };
}

// ─── METHOD HISTORY (via published internal services) ────────────────────

// Published UUIDs of the Expertly.Automation.Method.History service methods.
// These are stable across environments (the internal services are core
// platform, not user-generated).
const HISTORY_SERVICE = {
  listAll: "6b6ed77c-ecb3-4ae1-a43c-1c12ea3261d4",
  get: "4b0b2407-951e-48f0-9796-ef0a361b803e",
  restore: "4c834d4037cf50b8c986b44feab121c7",
};

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

  const path = `/rest/api/automation/chain/execute/${HISTORY_SERVICE.listAll}?encrypted=true`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Raw",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new CliError(`History listAll failed: ${response.status}`, {
      code: "HISTORY_LIST_FAILED",
      details: await response.text(),
    });
  }

  const body = (await response.json()) as Record<string, unknown>;
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

  const path = `/rest/api/automation/chain/execute/${HISTORY_SERVICE.get}?encrypted=true`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Raw",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new CliError(`History get failed: ${response.status}`, {
      code: "HISTORY_GET_FAILED",
      details: await response.text(),
    });
  }

  const body = (await response.json()) as Record<string, unknown>;
  const inner = extractHistoryResponseSingle(body);

  return {
    ...normalizeVersionSummary(inner),
    jsonDefinition: inner.jsonDefinition,
  };
}

/**
 * Restore a method to a previous version. Calls the published
 * Expertly.Automation.Method.History.restore service.
 */
export async function historyRestore(opts: {
  category: string;
  methodName: string;
  version: number;
  includeDraft?: boolean;
}): Promise<boolean> {
  const payload: Record<string, unknown> = {
    serviceName: opts.category,
    methodName: opts.methodName,
    version: String(opts.version),
  };
  if (opts.includeDraft) payload.includeDraft = "true";

  const path = `/rest/api/automation/chain/execute/${HISTORY_SERVICE.restore}?encrypted=true`;
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Raw",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new CliError(`History restore failed: ${response.status}`, {
      code: "HISTORY_RESTORE_FAILED",
      details: await response.text(),
    });
  }

  const body = (await response.json()) as Record<string, unknown>;
  const inner = body.response;
  if (typeof inner === "boolean") return inner;
  if (typeof inner === "object" && inner != null) {
    const r = (inner as Record<string, unknown>).response;
    return r === true || r === "true";
  }
  return true;
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

// Legacy helper kept for the `test` command's error-enrichment path where it
// walks parsedSteps by automationId. Not exported from adApi.
export function findStepByAutomationId(steps: ParsedStep[], id: string) {
  return steps.find(s => s.automationId === id);
}
