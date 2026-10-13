// Report Designer wire client: every RD request goes through here, on core
// `apiFetch` (env session, 401 refresh, timeouts). The routes are the ones the
// RD web app calls; lib/README.md lists them with what each one does on the
// server (several "reads" execute the report's datasource method).

import { apiFetch, apiError, CliError, isObj, readJsonOrNull, type Obj } from "@belzabar/core";

const RD_V2 = "/rest/api/v2/reports";
const RD_V3 = "/rest/api/v3/reports";
/** Export polling (not under /v2). */
const RD_DOWNLOAD = "/rest/api/reports/download";
/** AD → reports reverse lookup (an AD route). */
const RD_DEPENDENTS = "/rest/api/automate/dependent/report";
/** AD chain by numeric id (an AD route). */
const AD_CHAIN = "/rest/api/automation/chain";

/** Exports and runs execute the datasource method on the server. */
const RD_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** The server's own error text (`errorMessage`), else the status line. */
function serverMessage(res: Response, body: unknown, what: string): string {
  const msg = isObj(body) && typeof body.errorMessage === "string" ? body.errorMessage : `${res.status} ${res.statusText}`.trim();
  return `${what} failed: ${msg}`;
}

interface CallOptions {
  method?: string;
  body?: unknown;
  /** What the call does, for the error message ("Run report"). */
  what: string;
  /** 404 → this code (default RD_NOT_FOUND). */
  notFoundCode?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

async function call<T>(path: string, opts: CallOptions): Promise<T | null> {
  const res = await apiFetch(path, {
    method: opts.method ?? "GET",
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  });
  if (!res.ok) {
    throw await apiError(res, {
      code: (s) => (s === 404 ? opts.notFoundCode ?? "RD_NOT_FOUND" : `RD_HTTP_${s}`),
      message: (r, b) => serverMessage(r, b, opts.what),
      path,
    });
  }
  return readJsonOrNull<T>(res, { path });
}

const qs = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

function list(value: unknown, path: string): Obj[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new CliError(`Expected a list from ${path}.`, { code: "RD_BAD_RESPONSE", details: { path } });
  }
  return value.filter(isObj);
}

function object(value: unknown, path: string): Obj {
  if (!isObj(value)) throw new CliError(`Expected an object from ${path}.`, { code: "RD_BAD_RESPONSE", details: { path } });
  return value;
}

// ── reports ────────────────────────────────────────────────────────────────

export const SORT_TYPES = {
  role: "MY_ROLE",
  executed: "RECENTLY_EXECUTED",
  owner: "OWNER",
  created: "DATE_CREATED",
  popular: "POPULARITY",
} as const;

/** List rows (no configuration). `searchTerm` matches the title. */
export async function listReports(opts: { search?: string; sort: keyof typeof SORT_TYPES; limit: number; offset?: number }): Promise<Obj[]> {
  const path = `${RD_V2}?${qs({ sortType: SORT_TYPES[opts.sort], searchTerm: opts.search, limit: opts.limit, offset: opts.offset ?? 0 })}`;
  return list(await call(path, { what: "List reports" }), path);
}

/** Metadata only (title, status, owner, datasource name, dates). Side-effect free. */
export async function getReportBasic(id: string): Promise<Obj> {
  const path = `${RD_V2}/${id}?apiInfoLevel=BASIC`;
  return object(await call(path, { what: `Read report ${id}` }), path);
}

/**
 * The saved definition, already parsed (name, description, columns, filters,
 * summaries, dataSourceId, dataSourceCategoryUuid, contributors, filterRequired).
 * Side-effect free; 404 for an unknown id.
 */
export async function getReportDefinition(id: string): Promise<Obj> {
  const path = `${RD_V3}?${qs({ reportId: id })}`;
  const rows = list(await call(path, { what: `Read report ${id}` }), path);
  if (!rows[0]) throw new CliError(`Report ${id} not found.`, { code: "RD_NOT_FOUND", details: { id } });
  return rows[0];
}

/**
 * The full record with the configuration string. RUNS THE REPORT (executes the
 * datasource method, updates its execution time); only for `--exact`.
 */
export async function getReportDetailed(id: string): Promise<Obj> {
  const path = `${RD_V2}/${id}?${qs({ apiInfoLevel: "DETAILED", offset: 0, limit: 1 })}`;
  return object(await call(path, { what: `Read report ${id}`, timeoutMs: RD_RUN_TIMEOUT_MS }), path);
}

/** A new empty report ("Report, <date>"); returns its record. */
export async function createEmptyReport(): Promise<Obj> {
  return object(await call(RD_V2, { method: "POST", what: "Create report" }), RD_V2);
}

/** Title / description / status. `execute` is what the UI sends for archive and unarchive. */
export async function patchReport(id: string, body: Obj, opts: { execute?: boolean } = {}): Promise<Obj> {
  const path = `${RD_V2}/${id}${opts.execute ? "?execute=true" : ""}`;
  return object(await call(path, { method: "PATCH", body, what: `Update report ${id}` }), path);
}

/** Save the definition (the configuration is JSON in a string). Last write wins. */
export async function saveConfiguration(id: string, configuration: string): Promise<Obj> {
  const path = `${RD_V2}/${id}?${qs({ offset: 0, limit: 1 })}`;
  return object(await call(path, { method: "PUT", body: { configuration }, what: `Save report ${id}` }), path);
}

/** Run `configuration` ad hoc against report `id`: rows are column-major in `data.columns[].data`. */
export async function runReport(id: string, configuration: string, page: { offset: number; limit: number }): Promise<Obj> {
  const path = `${RD_V2}/${id}?${qs(page)}`;
  return object(await call(path, { method: "POST", body: { configuration }, what: `Run report ${id}`, timeoutMs: RD_RUN_TIMEOUT_MS }), path);
}

/** `{totalRows}` for `configuration`. Executes the datasource. */
export async function countRows(id: string, configuration: string): Promise<number | null> {
  const path = `${RD_V2}/count/${id}?${qs({ offset: 0, limit: 1 })}`;
  const body = object(await call(path, { method: "POST", body: { configuration }, what: `Count rows of report ${id}`, timeoutMs: RD_RUN_TIMEOUT_MS }), path);
  const n = Number(body.totalRows);
  return Number.isFinite(n) ? n : null;
}

export const EXPORT_FORMATS = { csv: "CSV", xlsx: "XL", pdf: "PDF" } as const;

/** Queue an export: `{requestId, queued, email, pollTimeInSeconds}` (HTTP 202). */
export async function requestExport(id: string, configuration: string, format: keyof typeof EXPORT_FORMATS): Promise<Obj> {
  const path = `${RD_V2}/${id}/content?${qs({ format: EXPORT_FORMATS[format] })}`;
  return object(await call(path, { method: "POST", body: { configuration }, what: `Export report ${id}`, timeoutMs: RD_RUN_TIMEOUT_MS }), path);
}

/** `{status: "PROCESSING"}`, then `{fileURL, isEmail}`. The route answers 500 without a JSON Content-Type. */
export async function pollExport(requestId: string): Promise<Obj> {
  const path = `${RD_DOWNLOAD}/${requestId}`;
  return object(await call(path, { what: "Export status", headers: { "Content-Type": "application/json" } }), path);
}

/** Reports whose datasource is the method (draft or published uuid): `[{uuid, reportName}]`. */
export async function dependentReports(methodUuid: string): Promise<Obj[]> {
  const path = `${RD_DEPENDENTS}?${qs({ methodId: methodUuid, offset: 0, limit: 500 })}`;
  return list(await call(path, { what: "Reports using the method" }), path);
}

/**
 * The AD chain with this numeric id (`{id, uuid, name, category: {name, uuid}, automationState}`),
 * or null. Read-only; names a datasource whose report has no category uuid.
 */
export async function getChainById(chainId: string): Promise<Obj | null> {
  const path = `${AD_CHAIN}/${encodeURIComponent(chainId)}`;
  const value = await call<unknown>(path, { what: `Read AD chain ${chainId}`, notFoundCode: "RD_DATASOURCE_NOT_FOUND" }).catch((err) => {
    if (err instanceof CliError && err.code === "RD_DATASOURCE_NOT_FOUND") return null;
    throw err;
  });
  return isObj(value) ? value : null;
}

// ── datasources ────────────────────────────────────────────────────────────

/** The AD categories (the datasource categories): `{id, name, uuid, …}`. */
export async function listDatasourceCategories(): Promise<Obj[]> {
  const path = `${RD_V2}/datasources/category`;
  return list(await call(path, { what: "List datasource categories" }), path);
}

/** Published methods of a category usable as datasources: `{type, id (chain id), label (method name), description?}`. */
export async function listDatasources(categoryUuid: string): Promise<Obj[]> {
  const path = `${RD_V2}/datasources?${qs({ apiInfoLevel: "BASIC", categoryUuid })}`;
  return list(await call(path, { what: "List datasources" }), path);
}
