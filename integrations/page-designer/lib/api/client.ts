// Raw HTTP wrappers for every PD endpoint belz touches.
//
// One function per endpoint. No parsing, no business logic — this file only
// talks JSON with the server. Callers are expected to be the pdApi façade in
// lib/api/index.ts.
//
// All endpoints live under `/rest/api/pagedesigner`. Auth is Bearer via
// @belzabar/core's apiFetch, which auto-refreshes on 401.

import { apiFetch, CliError, httpError, readBodySummary, summarizeBody } from "@belzabar/core";
import type {
  RawPageResponse,
  RawPageDependencies,
  RawPartialUpdateOperation,
  RawHistoryEntry,
  RawPageListItem,
  PdStatus,
  PdEntityType,
} from "../types/wire";

const PD_BASE = "/rest/api/pagedesigner";

// -------- shared helpers --------------------------------------------------

// Non-OK → CliError via core's HTTP error mapping (body summarised: HTML →
// <title>, truncated, secret-redacted). PD keeps its stable codes:
// PD_LOCKED (409) / PD_API_ERROR (everything else).
async function ensureOk(response: Response, context: { method: string; path: string }): Promise<void> {
  if (response.ok) return;
  const mapped = await httpError(response, { method: context.method, path: context.path });
  throw new CliError(`${context.method} ${context.path} failed: HTTP ${response.status}`, {
    code: response.status === 409 ? "PD_LOCKED" : "PD_API_ERROR",
    details: mapped.details,
  });
}

/**
 * Parse a 2xx JSON body (OTH-R16). An empty body is null; a non-JSON body (an
 * SSO / maintenance HTML page served with 200) is PD_API_ERROR with a redacted
 * summary instead of a raw SyntaxError (UNHANDLED_EXCEPTION).
 */
export async function readJson<T>(response: Response, context: { method: string; path: string }): Promise<T | null> {
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    const summary = await readBodySummary(new Response(text, { headers: response.headers }));
    throw new CliError(`${context.method} ${context.path} returned a non-JSON body: ${summary}`, {
      code: "PD_API_ERROR",
      details: { status: response.status, body: summary },
    });
  }
}

// -------- reads -----------------------------------------------------------

export async function fetchPage(pageId: string): Promise<RawPageResponse | null> {
  const response = await apiFetch(`${PD_BASE}/pages/${pageId}`, {
    method: "GET",
    authMode: "Bearer",
  });
  if (response.status === 404) return null;
  await ensureOk(response, { method: "GET", path: `/pages/${pageId}` });
  return readJson<RawPageResponse>(response, { method: "GET", path: `/pages/${pageId}` });
}

/** A list row is a component (symbol) when the server marks it so. */
export function isComponentRow(item: RawPageListItem): boolean {
  if (typeof item.isComponent === "boolean") return item.isComponent;
  if (typeof item.isSymbol === "boolean") return item.isSymbol;
  const layout = item.layout as { isSymbol?: unknown } | undefined;
  return !!layout && layout.isSymbol === true;
}

/**
 * The id of the DRAFT component with exactly this name, or null when there is
 * none. Several components with one name → PD_NAME_AMBIGUOUS (never guess:
 * names are not unique, PD-1).
 */
export async function fetchComponentIdByName(name: string): Promise<string | null> {
  const items = (await searchPagesByName(name, "DRAFT")).filter(
    (i) => i.name === name && isComponentRow(i) && typeof i.id === "string",
  );
  if (items.length === 0) return null;
  if (items.length > 1) {
    throw new CliError(`${items.length} components are named "${name}"; pass an id instead.`, {
      code: "PD_NAME_AMBIGUOUS",
      details: { name, ids: items.map((i) => i.id) },
    });
  }
  return items[0]!.id as string;
}

export async function searchPagesByName(
  name: string,
  status: PdStatus,
): Promise<RawPageListItem[]> {
  const url = `${PD_BASE}/pages?name=${encodeURIComponent(name)}&apiInfoLevel=MEDIUM&status=${status}`;
  const response = await apiFetch(url, { method: "GET", authMode: "Bearer" });
  if (response.status === 404) return [];
  // PD-18: a 401/5xx is an API error, not "no such page".
  await ensureOk(response, { method: "GET", path: "/pages?name=" });
  const data = await readJson<unknown>(response, { method: "GET", path: "/pages?name=" });
  return Array.isArray(data) ? (data as RawPageListItem[]) : [];
}

export async function fetchDeployablePageByAppUrl(
  domain: string,
  path: string,
): Promise<string | null> {
  const params = new URLSearchParams({ pageType: "ALL", domain, path });
  const response = await apiFetch(
    `/rest/api/public/pagedesigner/deployable/pages?${params}`,
    { method: "GET", authMode: "Bearer" },
  );
  if (response.status === 404) return null;
  await ensureOk(response, { method: "GET", path: "/deployable/pages" });
  const data = await readJson<{ deployedPages?: Array<{ referencePageId: string }> }>(response, {
    method: "GET",
    path: "/deployable/pages",
  });
  return data?.deployedPages?.[0]?.referencePageId ?? null;
}

const PAGE_LIST_LIMIT = 2000;

export async function fetchAllPages(): Promise<RawPageListItem[]> {
  const results: RawPageListItem[] = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      status: "DRAFT",
      pageType: "PAGE",
      limit: String(PAGE_LIST_LIMIT),
      offset: String(offset),
    });
    const response = await apiFetch(`${PD_BASE}/pages?${params}`, {
      method: "GET",
      authMode: "Bearer",
    });
    await ensureOk(response, { method: "GET", path: "/pages (all)" });
    const data = await readJson<unknown[]>(response, { method: "GET", path: "/pages (all)" });
    const items = Array.isArray(data) ? data : [];
    results.push(...(items as RawPageListItem[]));
    if (items.length < PAGE_LIST_LIMIT) break;
    offset += PAGE_LIST_LIMIT;
  }
  return results;
}

export async function fetchAllComponents(): Promise<RawPageListItem[]> {
  const results: RawPageListItem[] = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      apiInfoLevel: "MEDIUM",
      pageType: "COMPONENT",
      notStatus: "DELETED",
      limit: String(PAGE_LIST_LIMIT),
      offset: String(offset),
    });
    const response = await apiFetch(`${PD_BASE}/pages?${params}`, {
      method: "GET",
      authMode: "Bearer",
    });
    await ensureOk(response, { method: "GET", path: "/pages (components)" });
    const data = await readJson<unknown[]>(response, { method: "GET", path: "/pages (components)" });
    const items = Array.isArray(data) ? data : [];
    results.push(...(items as RawPageListItem[]));
    if (items.length < PAGE_LIST_LIMIT) break;
    offset += PAGE_LIST_LIMIT;
  }
  return results;
}

export async function fetchPageDependencies(
  publishedId: string,
  status: PdStatus = "PUBLISHED",
): Promise<RawPageDependencies> {
  const params = new URLSearchParams({ id: publishedId, status });
  const response = await apiFetch(
    `${PD_BASE}/pages/page-dependencies?${params}`,
    { method: "GET", authMode: "Bearer" },
  );
  await ensureOk(response, { method: "GET", path: "/pages/page-dependencies" });
  return (await readJson<RawPageDependencies>(response, { method: "GET", path: "/pages/page-dependencies" })) ?? ({} as RawPageDependencies);
}

// -------- history --------------------------------------------------------

export async function historyList(pageId: string): Promise<RawHistoryEntry[]> {
  const response = await apiFetch(
    `${PD_BASE}/pages/history?pageId=${encodeURIComponent(pageId)}`,
    { method: "GET", authMode: "Bearer" },
  );
  await ensureOk(response, { method: "GET", path: "/pages/history" });
  const data = await readJson<unknown>(response, { method: "GET", path: "/pages/history" });
  return Array.isArray(data) ? (data as RawHistoryEntry[]) : [];
}

export async function historyGet(versionId: number | string): Promise<RawPageResponse | null> {
  const response = await apiFetch(
    `${PD_BASE}/pages/version/${encodeURIComponent(String(versionId))}`,
    { method: "GET", authMode: "Bearer" },
  );
  if (response.status === 404) return null;
  await ensureOk(response, { method: "GET", path: `/pages/version/${versionId}` });
  return readJson<RawPageResponse>(response, { method: "GET", path: `/pages/version/${versionId}` });
}

export async function historyRestore(versionId: number | string): Promise<void> {
  const response = await apiFetch(
    `${PD_BASE}/pages/revert/${encodeURIComponent(String(versionId))}`,
    {
      method: "PUT",
      authMode: "Bearer",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    },
  );
  await ensureOk(response, { method: "PUT", path: `/pages/revert/${versionId}` });
}

// -------- writes ---------------------------------------------------------

export interface SaveResult {
  newVersionId: number | null;
  raw: unknown;
}

/**
 * The JSON answer of a PD write that already returned 2xx. An empty or
 * non-JSON body is `{}` (the write stands); a body read that stalls (core
 * HTTP_TIMEOUT, NEW-2) is NOT swallowed: the write was accepted but its answer
 * is unknown, so the caller must re-read before trusting or retrying it.
 */
async function writeAnswer(response: Response, what: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (e) {
    if (e instanceof SyntaxError) return {};
    if (e instanceof CliError) {
      const details = typeof e.details === "object" && e.details !== null ? (e.details as Record<string, unknown>) : {};
      throw new CliError(
        `${what} was accepted (HTTP ${response.status}) but its response could not be read: ${e.message} ` +
          `Re-read the page before retrying.`,
        { code: e.code, exitCode: e.exitCode, details: { ...details, status: response.status, mayHaveCompleted: true, retryable: false } },
      );
    }
    throw e;
  }
}

export async function savePageFull(
  pageId: string,
  status: PdStatus,
  configurationString: string,
): Promise<SaveResult> {
  const body = {
    status,
    partialUpdate: false,
    configuration: configurationString,
  };
  const response = await apiFetch(`${PD_BASE}/pages/${pageId}`, {
    method: "PUT",
    authMode: "Bearer",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  await ensureOk(response, { method: "PUT", path: `/pages/${pageId} (full)` });
  const raw = ((await writeAnswer(response, `PD save of ${pageId}`)) ?? {}) as Record<string, unknown>;
  return {
    newVersionId: typeof raw.versionId === "number" ? raw.versionId : null,
    raw,
  };
}

export async function savePagePartial(
  pageId: string,
  status: PdStatus,
  operations: RawPartialUpdateOperation[],
): Promise<SaveResult> {
  const body = {
    status,
    partialUpdate: true,
    pageElementOperations: operations,
  };
  const response = await apiFetch(`${PD_BASE}/pages/${pageId}`, {
    method: "PUT",
    authMode: "Bearer",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  await ensureOk(response, { method: "PUT", path: `/pages/${pageId} (partial)` });
  const raw = ((await writeAnswer(response, `PD save of ${pageId}`)) ?? {}) as Record<string, unknown>;
  return {
    newVersionId: typeof raw.versionId === "number" ? raw.versionId : null,
    raw,
  };
}

export async function publishPage(
  pageId: string,
  opts: { landingPage?: boolean; hostIds?: string[] } = {},
): Promise<unknown> {
  // The server reads publish parameters from the QUERY STRING, not the body.
  // Sending hostIds in a JSON body (as belz used to) means the server sees no
  // host: it updates the PUBLISHED sibling record but never DEPLOYS the page
  // to a host, so the live app keeps serving the previously-deployed config.
  // The PD designer's "Publish and Deploy" sends ?landingPage=&hostIds= as
  // query params — match that. hostIds is a comma-separated list.
  const params = new URLSearchParams();
  params.set("landingPage", String(opts.landingPage === true));
  if (opts.hostIds && opts.hostIds.length > 0) {
    params.set("hostIds", opts.hostIds.join(","));
  }
  const response = await apiFetch(`${PD_BASE}/pages/${pageId}/publish?${params}`, {
    method: "POST",
    authMode: "Bearer",
  });
  await ensureOk(response, { method: "POST", path: `/pages/${pageId}/publish` });
  return writeAnswer(response, `PD publish of ${pageId}`);
}

// -------- lock -----------------------------------------------------------

export async function acquireLock(pageId: string): Promise<void> {
  // Both acquire and release use the SAME query-param shape. The server
  // explicitly rejects body-as-JSON with "Required request parameter
  // 'pageLockAction' ... is not present". See expertly figma-to-pd/SKILL.md
  // §"Edit lock" and the common-errors table.
  const response = await apiFetch(
    `${PD_BASE}/pages/lock/${pageId}?pageLockAction=ACQUIRED`,
    { method: "PUT", authMode: "Bearer" },
  );
  if (response.status === 409) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    throw new CliError(
      `Page ${pageId} is locked by another session.`,
      {
        code: "PD_LOCKED",
        details: { status: 409, body: summarizeBody(text, response.headers.get("content-type"), 500), holder: lockHolderFields(text) },
      },
    );
  }
  await ensureOk(response, { method: "PUT", path: `/pages/lock/${pageId} (acquire)` });
}

/**
 * Who holds the lock, as far as a 409 body says: every scalar field (at any
 * depth) whose key names a user / owner / lock holder / email. Empty when
 * the body is not JSON or names nobody.
 */
export function lockHolderFields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 4 || v === null || v === undefined) return;
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    const leaf = path.split(".").pop() ?? "";
    if (/(At|Time|Date|On)$/.test(leaf)) return; // lockedAt, createdOn: timestamps, not holders
    if (/user|owner|locked|holder|by$|email/i.test(path) && (typeof v === "string" || typeof v === "number")) out[path] = String(v);
  };
  walk(parsed, "", 0);
  return out;
}

/** The signed-in user (`GET /rest/api/users/me` → `{user}`): id, email, user name. Null when unreadable. */
export async function fetchCurrentUserIdentity(): Promise<string[] | null> {
  const response = await apiFetch("/rest/api/users/me", { method: "GET", authMode: "Bearer" });
  if (!response.ok) {
    await readBodySummary(response);
    return null;
  }
  const body = (await response.json().catch((e: unknown) => {
    if (e instanceof SyntaxError) return null;
    throw e;
  })) as { user?: Record<string, unknown> } | null;
  const u = body?.user;
  if (!u) return null;
  return [u.id, u.email, u.userName, u.username, u.loginId]
    .filter((x): x is string | number => (typeof x === "string" && x.trim() !== "") || typeof x === "number")
    .map((x) => String(x).trim().toLowerCase());
}

/**
 * Release the lock. Returns true when the server accepted the release, false
 * when it refused (e.g. the lock is held by someone else, or already gone).
 * Never throws for an HTTP refusal — callers decide how to report it (PD-20).
 */
export async function releaseLock(pageId: string): Promise<boolean> {
  return (await releaseLockStatus(pageId)) < 300;
}

/** Release the lock and return the HTTP status (2xx = released; 4xx = refused; 5xx = unknown). */
export async function releaseLockStatus(pageId: string): Promise<number> {
  const response = await apiFetch(
    `${PD_BASE}/pages/lock/${pageId}?pageLockAction=RELEASED`,
    { method: "PUT", authMode: "Bearer" },
  );
  if (!response.ok) await readBodySummary(response); // drain
  return response.status;
}

// Re-export entity-type helper used by draft-guard + resolver.
export type { PdStatus, PdEntityType };
