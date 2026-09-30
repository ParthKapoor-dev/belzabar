import type { MigrateOutcome, ParsedMigrationOutput, RawReport, ReportEntity, ReportEntityRow, ReportSummary } from "./types";

export function summarizeReport(report: RawReport | undefined): ReportSummary | undefined {
  if (!report || typeof report !== "object") return undefined;

  const items: ReportEntity[] = Array.isArray(report.methodComparisonResult)
    ? report.methodComparisonResult
    : Array.isArray(report.comparisonResults)
      ? report.comparisonResults
      : [];

  let mismatchCount = 0;
  let identicalCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let unchangedCount = 0;
  const entities: ReportEntityRow[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.identical === true) identicalCount += 1;
    if (item.identical === false) mismatchCount += 1;
    const status = (item.entityMigrationStatus ?? "").toString().toUpperCase();
    if (status === "COMPLETED") completedCount += 1;
    if (status === "FAILED" || status === "ERROR") failedCount += 1;
    if (status === "UNCHANGED") unchangedCount += 1;
    entities.push({
      id: typeof item.entityId === "string" ? item.entityId : undefined,
      name: typeof item.entityName === "string" ? item.entityName : undefined,
      status: status || undefined,
      identical: typeof item.identical === "boolean" ? item.identical : undefined,
    });
  }

  return {
    migrationId: typeof report.migrationId === "string" ? report.migrationId : undefined,
    migrationStatus: typeof report.migrationStatus === "string" ? report.migrationStatus : undefined,
    entityCount: items.length,
    identicalCount,
    mismatchCount,
    completedCount,
    failedCount,
    unchangedCount,
    entities,
  };
}

/**
 * What a finished build changed, from the console's skip notices and the
 * report rows: NOTHING_MIGRATED when every requested id was skipped or
 * UNCHANGED, or the report lists entities but none COMPLETED; PARTIAL when
 * some were; MIGRATED otherwise. `unchanged` lists the ids that did not change.
 */
export function migrationOutcome(
  requestedIds: readonly string[],
  parsed: Pick<ParsedMigrationOutput, "skipped" | "reportSummary">,
): { outcome: MigrateOutcome; unchanged: string[] } {
  const unchanged: string[] = [];
  const add = (id: string | undefined) => {
    const key = id?.trim().toLowerCase();
    if (key && !unchanged.includes(key)) unchanged.push(key);
  };
  for (const s of parsed.skipped) add(s.id);
  const report = parsed.reportSummary;
  for (const e of report?.entities ?? []) if (e.status === "UNCHANGED") add(e.id);

  const requested = requestedIds.map((id) => id.trim().toLowerCase()).filter(Boolean);
  const allRequestedUnchanged = requested.length > 0 && requested.every((id) => unchanged.includes(id));
  const noneCompleted = !!report && report.entityCount > 0 && report.completedCount === 0;
  if (allRequestedUnchanged || noneCompleted) return { outcome: "NOTHING_MIGRATED", unchanged };
  return { outcome: unchanged.length > 0 ? "PARTIAL" : "MIGRATED", unchanged };
}
