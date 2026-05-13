import type { ReportSummary } from "./types";

export function summarizeMigrationReport(rawReport: unknown): ReportSummary | undefined {
  if (!rawReport || typeof rawReport !== "object") {
    return undefined;
  }

  const report = rawReport as {
    migrationId?: unknown;
    migrationStatus?: unknown;
    statusCode?: unknown;
    comparisonResults?: unknown;
  };

  const results = Array.isArray(report.comparisonResults) ? report.comparisonResults : [];

  let mismatchCount = 0;
  let successCount = 0;
  let failedCount = 0;

  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as { comparisonStatus?: unknown; status?: unknown };
    const comparisonStatus = typeof row.comparisonStatus === "string" ? row.comparisonStatus : "";
    const status = typeof row.status === "string" ? row.status : "";

    if (comparisonStatus.toUpperCase() === "MISMATCH") mismatchCount += 1;
    if (status.toUpperCase() === "SUCCESS") successCount += 1;
    if (status.toUpperCase() === "FAILED") failedCount += 1;
  }

  return {
    migrationId: typeof report.migrationId === "string" ? report.migrationId : undefined,
    migrationStatus: typeof report.migrationStatus === "string" ? report.migrationStatus : undefined,
    statusCode: typeof report.statusCode === "number" ? report.statusCode : undefined,
    entityCount: results.length,
    mismatchCount,
    successCount,
    failedCount,
  };
}
