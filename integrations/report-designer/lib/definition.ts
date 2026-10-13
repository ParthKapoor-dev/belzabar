// Report definitions: reading a saved report without running it, the portable
// spec (`rd export` writes it), and the configuration string the server stores.
//
// The server keeps a report's definition as JSON inside a string
// (`configuration`). The side-effect-free reads (v3 definition + BASIC record)
// return everything except two display settings, `summaryPosition` and
// `filterConfig`; only the DETAILED read has them, and it runs the report, so
// it is opt-in (`exact`).

import { CliError, isObj, readJsonInput, str, type Obj } from "@belzabar/core";
import { getReportBasic, getReportDefinition, getReportDetailed } from "./api";
import { describeDataSource, type DataSourceRef, type ResolvedDataSource } from "./datasource";

export const SPEC_FORMAT = "belz.rd.report/1";
export const DEFAULT_SUMMARY_POSITION = { label: "Show summaries at top", value: "top" } as const;
/** Fields only the executing DETAILED read returns. */
const EXACT_ONLY_FIELDS = ["summaryPosition", "filterConfig"] as const;

/** The portable report definition: no env-local ids. */
export interface ReportSpec {
  format?: string;
  title: string;
  description?: string;
  dataSource: DataSourceRef;
  columns: Obj[];
  filters: Obj[];
  summaries: Obj[];
  summaryPosition?: Obj;
  filterConfig?: number;
  isFilterRequired?: boolean;
}

export interface ReportMeta {
  id: string;
  title: string;
  status: string | null;
  serialId: number | null;
  ownerId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastExecutedAt: string | null;
}

export interface SavedReport {
  meta: ReportMeta;
  spec: ReportSpec;
  /** The env-local datasource ids as saved, with their names when still listed. */
  dataSource: { id: string | null; categoryUuid: string | null; category: string | null; method: string | null };
  /** Spec fields that could not be read without running the report (empty with `exact`). */
  unread: string[];
}

const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Read a saved report. Never runs it, unless `exact` (then the report is executed once, 1 row). */
export async function readReport(id: string, opts: { exact?: boolean } = {}): Promise<SavedReport> {
  const def = await getReportDefinition(id);
  const basic = await getReportBasic(id);
  let saved: Obj = def;
  if (opts.exact) {
    const detailed = await getReportDetailed(id);
    saved = parseConfiguration(detailed.configuration, id);
  }

  const dsId = saved.dataSourceId === undefined || saved.dataSourceId === null ? null : String(saved.dataSourceId);
  const dsCat = str(saved.dataSourceCategoryUuid)?.trim() ?? null;
  const names = await describeDataSource(dsId, dsCat);
  // The record names the method itself; it survives an unlisted (e.g. unpublished) datasource.
  const method = names.method ?? (str(basic.dataSourceName)?.trim() || null);

  const title = str(basic.title) ?? str(def.name) ?? "";
  const description = str(saved.description);
  const spec: ReportSpec = {
    format: SPEC_FORMAT,
    title,
    ...(description ? { description } : {}),
    dataSource: { category: names.category ?? "", method: method ?? "" },
    columns: arr(saved.columns),
    filters: arr(saved.filters),
    summaries: arr(saved.summaries),
    ...(opts.exact && isObj(saved.summaryPosition) ? { summaryPosition: saved.summaryPosition } : {}),
    ...(opts.exact && numOrNull(saved.filterConfig) !== null ? { filterConfig: saved.filterConfig as number } : {}),
    isFilterRequired: Boolean(saved.isFilterRequired ?? saved.filterRequired ?? false),
  };

  return {
    meta: {
      id,
      title,
      status: str(basic.reportStatus) ?? null,
      serialId: numOrNull(basic.serialId),
      ownerId: numOrNull(basic.ownerId),
      createdAt: str(basic.createdAt) ?? null,
      updatedAt: str(basic.updatedAt) ?? null,
      lastExecutedAt: str(basic.lastExecutedAt) ?? null,
    },
    spec,
    dataSource: { id: dsId, categoryUuid: dsCat, category: names.category, method },
    unread: opts.exact ? [] : [...EXACT_ONLY_FIELDS],
  };
}

function parseConfiguration(value: unknown, id: string): Obj {
  if (isObj(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (isObj(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  throw new CliError(`Report ${id} has no readable configuration.`, { code: "RD_BAD_RESPONSE", details: { id } });
}

/** The configuration string the server stores, for `spec` on the env `ds` was resolved on. */
export function toConfiguration(spec: ReportSpec, ds: Pick<ResolvedDataSource, "id" | "categoryUuid">): string {
  return JSON.stringify({
    name: spec.title,
    ...(spec.description ? { description: spec.description } : {}),
    dataSourceId: ds.id,
    dataSourceType: "SERVICE",
    dataSourceCategoryUuid: ds.categoryUuid,
    columns: spec.columns,
    filters: spec.filters,
    summaries: spec.summaries,
    summaryPosition: spec.summaryPosition ?? DEFAULT_SUMMARY_POSITION,
    filterConfig: spec.filterConfig ?? 0,
    isFilterRequired: spec.isFilterRequired ?? false,
  });
}

/** The saved report's own configuration (its env-local ids), for running it as saved. */
export function savedConfiguration(report: SavedReport): string {
  if (!report.dataSource.id || !report.dataSource.categoryUuid) {
    throw new CliError(`Report ${report.meta.id} has no datasource yet; save a definition first.`, {
      code: "RD_NO_DATASOURCE",
      details: { id: report.meta.id },
    });
  }
  return toConfiguration(report.spec, { id: report.dataSource.id, categoryUuid: report.dataSource.categoryUuid });
}

/** Validate a spec file's content. Every problem is listed in RD_SPEC_INVALID. */
export function parseSpec(value: unknown): ReportSpec {
  const problems: string[] = [];
  if (!isObj(value)) throw new CliError("A report spec must be a JSON object.", { code: "RD_SPEC_INVALID", details: { problems: ["not an object"] } });
  if (value.format !== undefined && value.format !== SPEC_FORMAT) problems.push(`format must be "${SPEC_FORMAT}"`);
  if (!str(value.title)?.trim()) problems.push("title: a non-empty string is required");
  if (value.description !== undefined && typeof value.description !== "string") problems.push("description: must be a string");
  const ds = value.dataSource;
  if (!isObj(ds) || !str(ds.category)?.trim() || !str(ds.method)?.trim()) {
    problems.push('dataSource: {"category": "<AD category>", "method": "<published AD method>"} is required');
  }
  for (const key of ["columns", "filters", "summaries"] as const) {
    if (value[key] !== undefined && !Array.isArray(value[key])) problems.push(`${key}: must be an array`);
  }
  const columns = arr(value.columns);
  if (columns.length === 0) problems.push("columns: at least one column is required");
  const ids = new Set<string>();
  columns.forEach((c, i) => {
    const id = c.id === undefined || c.id === null ? "" : String(c.id);
    if (!id || !str(c.name)) problems.push(`columns[${i}]: id and name are required`);
    if (id && ids.has(id)) problems.push(`columns[${i}]: duplicate id ${id}`);
    ids.add(id);
  });
  arr(value.filters).forEach((f, i) => {
    const id = f.columnId === undefined || f.columnId === null ? "" : String(f.columnId);
    if (!ids.has(id)) problems.push(`filters[${i}]: columnId ${id || "(missing)"} is not one of the columns`);
  });
  if (value.filterConfig !== undefined && ![0, 1, 2].includes(value.filterConfig as number)) problems.push("filterConfig: must be 0, 1 or 2");
  if (value.summaryPosition !== undefined && !isObj(value.summaryPosition)) problems.push("summaryPosition: must be an object");
  if (value.isFilterRequired !== undefined && typeof value.isFilterRequired !== "boolean") problems.push("isFilterRequired: must be true or false");
  if (problems.length > 0) {
    throw new CliError(`Invalid report spec: ${problems.join("; ")}.`, { code: "RD_SPEC_INVALID", details: { problems } });
  }
  const d = ds as Obj;
  return {
    format: SPEC_FORMAT,
    title: (value.title as string).trim(),
    ...(typeof value.description === "string" && value.description ? { description: value.description } : {}),
    dataSource: { category: (d.category as string).trim(), method: (d.method as string).trim() },
    columns,
    filters: arr(value.filters),
    summaries: arr(value.summaries),
    ...(isObj(value.summaryPosition) ? { summaryPosition: value.summaryPosition } : {}),
    ...(typeof value.filterConfig === "number" ? { filterConfig: value.filterConfig } : {}),
    ...(typeof value.isFilterRequired === "boolean" ? { isFilterRequired: value.isFilterRequired } : {}),
  };
}

/** One line per difference between two specs (titles, datasource, columns by id, filters, summaries). */
export function specChanges(before: ReportSpec, after: ReportSpec): string[] {
  const out: string[] = [];
  if (before.title !== after.title) out.push(`title: "${before.title}" → "${after.title}"`);
  if ((before.description ?? "") !== (after.description ?? "")) out.push("description changed");
  const ds = (s: ReportSpec) => `${s.dataSource.category}/${s.dataSource.method}`;
  if (ds(before) !== ds(after)) out.push(`datasource: ${ds(before)} → ${ds(after)}`);
  const byId = (cols: Obj[]) => new Map(cols.map((c) => [String(c.id), c]));
  const b = byId(before.columns);
  const a = byId(after.columns);
  for (const [id, c] of a) {
    if (!b.has(id)) out.push(`column added: ${String(c.name)}`);
    else if (JSON.stringify(b.get(id)) !== JSON.stringify(c)) out.push(`column changed: ${String(c.name)}`);
  }
  for (const [id, c] of b) if (!a.has(id)) out.push(`column removed: ${String(c.name)}`);
  const order = (cols: Obj[]) => cols.map((c) => String(c.id)).join(",");
  if (out.every((l) => !l.startsWith("column")) && order(before.columns) !== order(after.columns)) out.push("columns reordered");
  if (JSON.stringify(before.filters) !== JSON.stringify(after.filters)) out.push(`filters: ${before.filters.length} → ${after.filters.length} (changed)`);
  if (JSON.stringify(before.summaries) !== JSON.stringify(after.summaries)) out.push(`summaries: ${before.summaries.length} → ${after.summaries.length} (changed)`);
  if ((before.isFilterRequired ?? false) !== (after.isFilterRequired ?? false)) out.push("isFilterRequired changed");
  // Display settings: only when both sides know them (a non-exact read does not).
  for (const k of ["summaryPosition", "filterConfig"] as const) {
    if (before[k] !== undefined && after[k] !== undefined && JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(`${k} changed`);
  }
  return out;
}

/** Read and validate a spec file (`RD_SPEC_UNREADABLE` / `RD_SPEC_INVALID`). */
export async function readSpecFile(path: string): Promise<ReportSpec> {
  const value = await readJsonInput(path, {
    unreadable: (err, missing) =>
      new CliError(missing ? `Spec file not found: ${path}` : `Cannot read spec file ${path}: ${(err as Error).message}`, {
        code: "RD_SPEC_UNREADABLE",
        details: { path },
      }),
    invalid: (err) => new CliError(`Spec file ${path} is not valid JSON: ${(err as Error).message}`, { code: "RD_SPEC_INVALID", details: { path } }),
  });
  return parseSpec(value);
}
