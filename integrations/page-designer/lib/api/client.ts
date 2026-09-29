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
  RawPageLockDetails,
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

/**
 * Revert the DRAFT `draftId` to version `versionId`: `PUT
 * /pages/revert/<draftId>?versionId=<vid>` (verified live 2026-09-29,
 * tests/fixtures/wire/revert.json). The server copies the version's
 * configuration into that draft row, bumps its versionId and answers with the
 * draft `{id, versionId, configuration, status, …}`; the PUBLISHED row and the
 * history are untouched. (Given the PUBLISHED id instead, it rewrites the live
 * row directly, with no publish and no history entry — belz never does that.
 * The old `PUT /pages/revert/<vid>` form is a 400.)
 */
export async function historyRestore(draftId: string, versionId: number): Promise<RawPageResponse | null> {
  const path = `/pages/revert/${draftId}?versionId=${versionId}`;
  const response = await apiFetch(`${PD_BASE}/pages/revert/${encodeURIComponent(draftId)}?versionId=${encodeURIComponent(String(versionId))}`, {
    method: "PUT",
    authMode: "Bearer",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  });
  await ensureOk(response, { method: "PUT", path });
  const raw = await writeAnswer(response, `PD revert of ${draftId}`);
  return raw && typeof raw === "object" && typeof (raw as RawPageResponse).id === "string" ? (raw as RawPageResponse) : null;
}

// -------- writes ---------------------------------------------------------

export interface SaveResult {
  newVersionId: number | null;
  /** The stored configuration string the PUT answered with (the full page body, verified live), or null. */
  configuration: string | null;
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
    configuration: typeof raw.configuration === "string" ? raw.configuration : null,
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
    configuration: typeof raw.configuration === "string" ? raw.configuration : null,
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
//
// Wire behaviour (verified live 2026-09-29, tests/fixtures/wire/lock.json):
//   - ACQUIRED on a free page → 200 `true`.
//   - ACQUIRED on a page the signed-in user already holds (a manual
//     `belz pd lock acquire`, another belz run, or the user's own open PD
//     editor tab) → HTTP 400 with a database duplicate-key message — NOT 409.
//   - A locked page's GET carries `pageLockDetails` {status, userName,
//     createdBy, validTill, lockedByCurrentUser}; that, not the error body,
//     tells whose lock it is.
//   - RELEASED → 200 `true` when a lock was released, 200 `false` when there
//     was nothing (of ours) to release.
// A 409 for a lock held by ANOTHER user could not be produced (one account);
// its body is summarised as-is and the holder comes from pageLockDetails.

export type AcquireOutcome =
  | { acquired: true }
  /** The signed-in user already holds the lock; nothing changed server-side. */
  | { acquired: false; heldByMe: true; lock: RawPageLockDetails };

/** The lock details of a page (null when it is not locked or unreadable). */
export async function fetchLockDetails(pageId: string): Promise<RawPageLockDetails | null> {
  const page = await fetchPage(pageId);
  const d = page?.pageLockDetails;
  return d && typeof d === "object" ? d : null;
}

/** The holder fields worth showing: user name, user id, valid-till. */
export function lockHolder(d: RawPageLockDetails): { userName: string | null; userId: number | null; validTill: string | null } {
  return {
    userName: typeof d.userName === "string" ? d.userName : null,
    userId: typeof d.createdBy === "number" ? d.createdBy : null,
    validTill: typeof d.validTill === "string" ? d.validTill : null,
  };
}

export async function acquireLock(pageId: string): Promise<AcquireOutcome> {
  // Both acquire and release use the SAME query-param shape; a JSON body is
  // rejected with "Required request parameter 'pageLockAction' ... is not present".
  const path = `/pages/lock/${pageId} (acquire)`;
  const response = await apiFetch(
    `${PD_BASE}/pages/lock/${pageId}?pageLockAction=ACQUIRED`,
    { method: "PUT", authMode: "Bearer" },
  );
  let text = "";
  if (response.ok) {
    text = await response.text().catch(() => "");
    if (text.trim() !== "false") return { acquired: true };
  } else if (response.status !== 400 && response.status !== 409) {
    await ensureOk(response, { method: "PUT", path });
  } else {
    text = await response.text().catch(() => "");
  }
  // Refused (400 / 409 / 200 false): whose lock is it?
  const lock = await fetchLockDetails(pageId).catch(() => null);
  const body = summarizeBody(text, response.headers.get("content-type"), 500);
  if (lock?.lockedByCurrentUser === true) return { acquired: false, heldByMe: true, lock };
  if (lock || response.status === 409) {
    const holder = lock ? lockHolder(lock) : null;
    throw new CliError(
      `Page ${pageId} is locked by ${holder?.userName ?? "another user"}` +
        (holder?.validTill ? ` (until ${holder.validTill}, server time)` : "") + ".",
      { code: "PD_LOCKED", details: { status: response.status, body, holder } },
    );
  }
  throw new CliError(`PUT /pages/lock/${pageId} (acquire) failed: HTTP ${response.status}`, {
    code: "PD_API_ERROR",
    details: { status: response.status, body },
  });
}

export interface ReleaseOutcome {
  status: number;
  /** true = released; false = nothing of ours was held (200 false) or refused (4xx); null = unknown (5xx). */
  released: boolean | null;
}

/** Release the lock. Never throws for an HTTP refusal — callers decide how to report it (PD-20). */
export async function releaseLock(pageId: string): Promise<ReleaseOutcome> {
  const response = await apiFetch(
    `${PD_BASE}/pages/lock/${pageId}?pageLockAction=RELEASED`,
    { method: "PUT", authMode: "Bearer" },
  );
  if (!response.ok) {
    await readBodySummary(response); // drain
    return { status: response.status, released: response.status >= 500 ? null : false };
  }
  const text = await response.text().catch(() => "");
  return { status: response.status, released: text.trim() !== "false" };
}

// Re-export entity-type helper used by draft-guard + resolver.
export type { PdStatus, PdEntityType };
