// The write pipeline shared by `rd create`, `rd save` and `rd copy`.
//
// Report Designer has no history and no optimistic locking (last write wins),
// so belz keeps its own backup of a report before replacing its definition,
// refuses to write when the definition changed since it was read, and reads
// the result back to verify it.

import { mkdirSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR, CliError, Config, writeSecureJson } from "@belzabar/core";
import { createEmptyReport, getReportDefinition, patchReport, saveConfiguration } from "./api";
import { logIntent } from "./confirm";
import type { ResolvedDataSource } from "./datasource";
import { readReport, specChanges, toConfiguration, type ReportSpec, type SavedReport } from "./definition";

/** `~/.belz/rd/backups/<env>/<id>-<timestamp>.json`; never pruned by `belz cache`. */
export const RD_BACKUP_DIR = join(BELZ_CONFIG_DIR, "rd", "backups");

/** Write the report's current spec (restorable with `rd save <id> --spec <file>`); returns the path. */
function backupReport(report: SavedReport): string {
  const dir = join(RD_BACKUP_DIR, Config.activeEnv.name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const path = join(dir, `${report.meta.id}-${stamp}.json`);
  writeSecureJson(path, report.spec, { pretty: true });
  return path;
}

/** Fill `summaryPosition` / `filterConfig` the spec leaves out from `current` (when it knows them). */
function withDisplayFrom(spec: ReportSpec, current: ReportSpec | null): ReportSpec {
  if (!current) return spec;
  return {
    ...spec,
    ...(spec.summaryPosition === undefined && current.summaryPosition !== undefined ? { summaryPosition: current.summaryPosition } : {}),
    ...(spec.filterConfig === undefined && current.filterConfig !== undefined ? { filterConfig: current.filterConfig } : {}),
  };
}

/** The parsed definition as a stable string, for "did it change since we read it?". */
async function definitionFingerprint(id: string): Promise<string> {
  const d = await getReportDefinition(id);
  return JSON.stringify([d.name, d.description, d.columns, d.filters, d.summaries, d.dataSourceId, d.dataSourceCategoryUuid, d.filterRequired]);
}

interface WriteResult {
  id: string;
  dataSource: ResolvedDataSource;
  /** Differences between what was saved and the spec (empty = verified). */
  mismatches: string[];
}

/**
 * Put `spec` on report `id` (title/description PATCH, then the configuration PUT)
 * and read it back. `expectFingerprint` (from before the confirmation) makes a
 * concurrent change a RD_CONFLICT instead of a silent overwrite.
 */
async function writeSpec(
  id: string,
  spec: ReportSpec,
  ds: ResolvedDataSource,
  opts: { expectFingerprint?: string; titleChanged: boolean },
): Promise<WriteResult> {
  if (opts.expectFingerprint !== undefined && (await definitionFingerprint(id)) !== opts.expectFingerprint) {
    throw new CliError(`Report ${id} changed on the server since belz read it; nothing was written. Re-run to review the new state.`, {
      code: "RD_CONFLICT",
      details: { id },
    });
  }
  if (opts.titleChanged) {
    logIntent("PATCH", `/rest/api/v2/reports/${id}`, { id, title: spec.title });
    await patchReport(id, { title: spec.title, description: spec.description ?? "" });
  }
  logIntent("PUT", `/rest/api/v2/reports/${id}`, { id, dataSourceId: ds.id });
  await saveConfiguration(id, toConfiguration(spec, ds));

  const back = await readReport(id);
  const mismatches = specChanges({ ...spec, summaryPosition: undefined, filterConfig: undefined }, back.spec);
  if (back.dataSource.id !== ds.id) mismatches.push(`datasource id: expected ${ds.id}, read back ${back.dataSource.id}`);
  return { id, dataSource: ds, mismatches };
}

/** POST an empty report, then write `spec` into it. A failure after the POST names the new id. */
export async function createReport(spec: ReportSpec, ds: ResolvedDataSource): Promise<WriteResult> {
  logIntent("POST", "/rest/api/v2/reports", { title: spec.title });
  const created = await createEmptyReport();
  const id = typeof created.id === "string" ? created.id.trim() : "";
  if (!id) throw new CliError("The server did not return the new report's id.", { code: "RD_BAD_RESPONSE" });
  try {
    return await writeSpec(id, spec, ds, { titleChanged: true });
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(`Report ${id} was created but its definition was not saved: ${err.message} Retry with 'belz rd save ${id} --spec <file>'.`, {
        code: err.code,
        details: { createdId: id, ...(typeof err.details === "object" && err.details ? err.details : {}) },
      });
    }
    throw err;
  }
}

interface SavePlan {
  current: SavedReport;
  /** The spec to write: `wanted` with the display settings it leaves out taken from `current`. */
  spec: ReportSpec;
  changes: string[];
  /** Taken before any confirmation; `applySave` refuses when the report moved since. */
  fingerprint: string;
  /** The spec left a display setting out (the report's current one is kept). */
  displayFromCurrent: boolean;
}

/**
 * Read report `id` and diff it with `wanted`. The two display settings are only
 * in the executing read, so a real save runs the report once: to compare them,
 * and to keep the current ones when the spec leaves them out. A dry run does
 * neither.
 */
export async function planSave(id: string, wanted: ReportSpec, opts: { dryRun: boolean }): Promise<SavePlan> {
  const current = await readReport(id, { exact: !opts.dryRun });
  const fingerprint = await definitionFingerprint(id);
  const spec = withDisplayFrom(wanted, opts.dryRun ? null : current.spec);
  return {
    current,
    spec,
    changes: specChanges(current.spec, spec),
    fingerprint,
    displayFromCurrent: wanted.summaryPosition === undefined || wanted.filterConfig === undefined,
  };
}

/** Back up, write and verify a planned save. */
export async function applySave(id: string, plan: SavePlan, ds: ResolvedDataSource): Promise<{ backup: string; mismatches: string[] }> {
  const backup = backupReport(plan.current);
  const before = plan.current.spec;
  const titleChanged = plan.spec.title !== before.title || (plan.spec.description ?? "") !== (before.description ?? "");
  const result = await writeSpec(id, plan.spec, ds, { expectFingerprint: plan.fingerprint, titleChanged });
  return { backup, mismatches: result.mismatches };
}
