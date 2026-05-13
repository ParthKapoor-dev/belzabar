// Raw HTTP wrappers for every PD endpoint belz touches.
//
// One function per endpoint. No parsing, no business logic — this file only
// talks JSON with the server. Callers are expected to be the pdApi façade in
// lib/api/index.ts.
//
// All endpoints live under `/rest/api/pagedesigner`. Auth is Bearer via
// @belzabar/core's apiFetch, which auto-refreshes on 401.

import { apiFetch, CliError } from "@belzabar/core";
import type {
  RawPageResponse,
  RawPartialUpdateOperation,
  RawHistoryEntry,
  RawPageListItem,
  PdStatus,
  PdEntityType,
} from "../types/wire";

const PD_BASE = "/rest/api/pagedesigner";

// -------- shared helpers --------------------------------------------------

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "";
  }
}

async function ensureOk(response: Response, context: { method: string; path: string }): Promise<void> {
  if (response.ok) return;
  const body = await readErrorBody(response);
  throw new CliError(
    `${context.method} ${context.path} failed: HTTP ${response.status}`,
    {
      code: response.status === 409 ? "PD_LOCKED" : "PD_API_ERROR",
      details: { status: response.status, body },
    },
  );
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

// Legacy name retained because existing commands import this identifier.
// New code should use fetchPage() directly.
export const fetchPageConfig = fetchPage;
export const fetchComponentConfig = fetchPage;

export async function fetchComponentIdByName(name: string): Promise<string | null> {
  // Existing behaviour: prefer a DRAFT symbol; fall back to the first match.
  const items = await searchPagesByName(name, "DRAFT");
  if (items.length === 0) return null;
  const infer = (item: RawPageListItem): boolean | null => {
    if (typeof item.isSymbol === "boolean") return item.isSymbol;
    const layout = item.layout as { isSymbol?: unknown } | undefined;
    if (layout && typeof layout.isSymbol === "boolean") return layout.isSymbol;
    return null;
  };
  const strict = items.find((i) => infer(i) === true);
  const pick = strict ?? items[0];
  if (pick && typeof pick.id === "string") return pick.id;
  return null;
}

export async function searchPagesByName(
  name: string,
  status: PdStatus,
): Promise<RawPageListItem[]> {
  const url = `${PD_BASE}/pages?name=${encodeURIComponent(name)}&apiInfoLevel=MEDIUM&status=${status}`;
  const response = await apiFetch(url, { method: "GET", authMode: "Bearer" });
  if (!response.ok) return [];
  return (await response.json()) as RawPageListItem[];
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
  if (!response.ok) return null;
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
  const body: Record<string, unknown> = { landingPage: opts.landingPage === true };
  if (opts.hostIds && opts.hostIds.length > 0) {
    body.hostIds = opts.hostIds.join(",");
  }
  const response = await apiFetch(`${PD_BASE}/pages/${pageId}/publish`, {
    method: "POST",
    authMode: "Bearer",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
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
    const body = await readErrorBody(response);
    throw new CliError(
      `Page ${pageId} is locked by another session.`,
      { code: "PD_LOCKED", details: { status: 409, body } },
    );
  }
  await ensureOk(response, { method: "PUT", path: `/pages/lock/${pageId} (acquire)` });
}

export async function releaseLock(pageId: string): Promise<void> {
  const response = await apiFetch(
    `${PD_BASE}/pages/lock/${pageId}?pageLockAction=RELEASED`,
    { method: "PUT", authMode: "Bearer" },
  );
  // Release is idempotent from the caller's perspective — a 4xx here usually
  // means the lock was already gone. Log but don't explode.
  if (!response.ok) {
    const body = await readErrorBody(response);
    process.stderr.write(
      `⚠️  releaseLock(${pageId}) got HTTP ${response.status}: ${body}\n`,
    );
  }
}

// Re-export entity-type helper used by draft-guard + resolver.
export type { PdStatus, PdEntityType };
