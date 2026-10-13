// Report definitions: reading a saved report without running it, the portable
// spec (`rd export` writes it), and the configuration string the server stores.
//
// The server keeps a report's definition as JSON inside a string
// (`configuration`). The side-effect-free reads (v3 definition + BASIC record)
// return everything except two display settings, `summaryPosition` and
// `filterConfig`; only the DETAILED read has them, and it runs the report, so
// it is opt-in (`exact`).

import { CliError, isObj, str, type Obj } from "@belzabar/core";
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

