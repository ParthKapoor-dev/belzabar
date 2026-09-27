// Raw HTTP wrappers for every PD endpoint belz touches.
//
// One function per endpoint. No parsing, no business logic — this file only
// talks JSON with the server. Callers are expected to be the pdApi façade in
// lib/api/index.ts.
//
// All endpoints live under `/rest/api/pagedesigner`. Auth is Bearer via
// @belzabar/core's apiFetch, which auto-refreshes on 401.

import { apiFetch, CliError, httpError, readBodySummary } from "@belzabar/core";
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

// -------- reads -----------------------------------------------------------

export async function fetchPage(pageId: string): Promise<RawPageResponse | null> {
  const response = await apiFetch(`${PD_BASE}/pages/${pageId}`, {
    method: "GET",
    authMode: "Bearer",
  });
  if (response.status === 404) return null;
  await ensureOk(response, { method: "GET", path: `/pages/${pageId}` });
  return (await response.json()) as RawPageResponse;
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
  const data = (await response.json()) as unknown;
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
  const data = (await response.json()) as {
    deployedPages?: Array<{ referencePageId: string }>;
  };
  return data.deployedPages?.[0]?.referencePageId ?? null;
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
    const data = (await response.json()) as unknown[];
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
    const data = (await response.json()) as unknown[];
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
  return (await response.json()) as RawPageDependencies;
}

// -------- history --------------------------------------------------------

export async function historyList(pageId: string): Promise<RawHistoryEntry[]> {
  const response = await apiFetch(
    `${PD_BASE}/pages/history?pageId=${encodeURIComponent(pageId)}`,
    { method: "GET", authMode: "Bearer" },
  );
  await ensureOk(response, { method: "GET", path: "/pages/history" });
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as RawHistoryEntry[]) : [];
}

export async function historyGet(versionId: number | string): Promise<RawPageResponse | null> {
  const response = await apiFetch(
    `${PD_BASE}/pages/version/${encodeURIComponent(String(versionId))}`,
    { method: "GET", authMode: "Bearer" },
  );
  if (response.status === 404) return null;
  await ensureOk(response, { method: "GET", path: `/pages/version/${versionId}` });
  return (await response.json()) as RawPageResponse;
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
  const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
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
  const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
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
  return response.json().catch(() => ({}));
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
    const body = await readBodySummary(response, 500);
    throw new CliError(
      `Page ${pageId} is locked by another session.`,
      { code: "PD_LOCKED", details: { status: 409, body } },
    );
  }
  await ensureOk(response, { method: "PUT", path: `/pages/lock/${pageId} (acquire)` });
}

/**
 * Release the lock. Returns true when the server accepted the release, false
 * when it refused (e.g. the lock is held by someone else, or already gone).
 * Never throws for an HTTP refusal — callers decide how to report it (PD-20).
 */
export async function releaseLock(pageId: string): Promise<boolean> {
  const response = await apiFetch(
    `${PD_BASE}/pages/lock/${pageId}?pageLockAction=RELEASED`,
    { method: "PUT", authMode: "Bearer" },
  );
  if (!response.ok) await readBodySummary(response); // drain
  return response.ok;
}

// Re-export entity-type helper used by draft-guard + resolver.
export type { PdStatus, PdEntityType };
