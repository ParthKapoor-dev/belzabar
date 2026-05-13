import type { RawReport, ReportEntity, ReportSummary } from "./types";

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

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.identical === true) identicalCount += 1;
    if (item.identical === false) mismatchCount += 1;
    const status = (item.entityMigrationStatus ?? "").toString().toUpperCase();
    if (status === "COMPLETED") completedCount += 1;
    if (status === "FAILED" || status === "ERROR") failedCount += 1;
  }

  return {
    migrationId: typeof report.migrationId === "string" ? report.migrationId : undefined,
    migrationStatus: typeof report.migrationStatus === "string" ? report.migrationStatus : undefined,
    entityCount: items.length,
    identicalCount,
    mismatchCount,
    completedCount,
    failedCount,
  };
}
