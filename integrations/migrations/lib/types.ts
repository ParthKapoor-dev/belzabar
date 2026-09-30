import type { JenkinsClient, MigrateType } from "./constants";
import type { BuildInfo, TriggerBuildInput } from "./jenkins";

type YesNo = "Y" | "N";

type ProfileSource = "live" | "cache";

export interface ProfilesByClient {
  client: JenkinsClient;
  profiles: string[];
}

export interface ProfileResolution {
  fetchedAt: string;
  source: ProfileSource;
  groups: ProfilesByClient[];
  flat: string[];
}

export interface ReportEntity {
  entityId?: string;
  entityName?: string;
  entityType?: { type?: string; subType?: string };
  entityMigrationStatus?: string;
  identical?: boolean;
  mismatchDetails?: unknown;
}

export interface RawReport {
  migrationId?: string;
  migrationStatus?: string;
  migrationTimestamp?: string;
  methodComparisonResult?: ReportEntity[];
  comparisonResults?: ReportEntity[];
  [key: string]: unknown;
}

/** One entity row of the migration report. */
export interface ReportEntityRow {
  id?: string;
  name?: string;
  /** `entityMigrationStatus`, upper-cased (COMPLETED, UNCHANGED, FAILED, …). */
  status?: string;
  identical?: boolean;
}

export interface ReportSummary {
  migrationId?: string;
  migrationStatus?: string;
  entityCount: number;
  identicalCount: number;
  mismatchCount: number;
  completedCount: number;
  failedCount: number;
  /** Entities the service left as they were (`UNCHANGED`, e.g. a same-version method). */
  unchangedCount: number;
  entities: ReportEntityRow[];
}

/** An id the migration script skipped (console `WARNING: Method <id> has same version (<n>) …`). */
export interface SkippedEntity {
  id: string;
  reason: "same-version";
  version?: number;
}

/**
 * What a followed, non-dry build actually changed: every requested entity
 * migrated, only some, or none (all skipped / UNCHANGED). The build result
 * alone says SUCCESS for all three.
 */
export type MigrateOutcome = "MIGRATED" | "PARTIAL" | "NOTHING_MIGRATED";

export interface ParsedMigrationOutput {
  cleanedOutput: string;
  successDetected: boolean;
  failureDetected: boolean;
  finishedResult?: string;
  runId?: string;
  migrationId?: string;
  sourceProfile?: string;
  sourceDb?: string;
  targetDb?: string;
  sourceHost?: string;
  targetHost?: string;
  failureHints: string[];
  /** Ids the migration script skipped (same version on source and target). */
  skipped: SkippedEntity[];
  /** Other `WARNING:` lines of the console, verbatim (run id prefix stripped). */
  warnings: string[];
  reportSummary?: ReportSummary;
  rawReport?: RawReport;
}

export interface ArtifactWriteInput {
  summary: unknown;
  consoleText: string;
}

export interface ArtifactWriteResult {
  summaryPath: string;
  consolePath: string;
}

export interface MigrateProfilesArgs {
  action: "profiles";
  refresh: boolean;
  client?: JenkinsClient;
}

export interface MigrateRunArgs {
  action: "run";
  client?: JenkinsClient;
  profile?: string;
  sourceEnv?: string;
  targetEnv?: string;
  migrateType: MigrateType | string;
  ids: string[];
  migrationId?: string;
  asyncMigration: YesNo;
  migrateDependent: YesNo;
  devopsTag?: string;
  dryRun: boolean;
  autoApprove: boolean;
  outPath?: string;
  quiet?: boolean;
  follow: boolean;
  /** Fail (exit 1) when the outcome is not MIGRATED. */
  strict: boolean;
  /** Skip the confirmation prompt (required with --llm or without a terminal). */
  yes?: boolean;
}

export interface MigrateStatusArgs {
  action: "status";
  buildNumber: number;
}

export interface MigrateLogsArgs {
  action: "logs";
  buildNumber: number;
}

export interface MigrateProfilesData {
  action: "profiles";
  source: ProfileSource;
  fetchedAt: string;
  groups: ProfilesByClient[];
  flat: string[];
}

/**
 * One migration id resolved against the source environment before the build is
 * triggered — see resolve-targets.ts. `resolvedId` is what actually gets sent
 * to Jenkins; it differs from `inputId` when a PD draft id was swapped for its
 * published sibling.
 */
export interface ResolvedTarget {
  inputId: string;
  resolvedId: string;
  name: string;
  kind: "PD" | "AD";
  status?: string;
  swapped: boolean;
}

export interface MigrateRunData {
  action: "run";
  jobName: string;
  jobUrl: string;
  buildNumber: number;
  buildUrl: string;
  result: BuildInfo["result"];
  duration: number;
  input: TriggerBuildInput;
  parsed: ParsedMigrationOutput;
  report?: ReportSummary;
  artifacts?: ArtifactWriteResult;
  /** Source-env id resolution performed before triggering the build. */
  resolvedTargets?: ResolvedTarget[];
  resolvedSourceEnv?: string;
  /** Followed, non-dry builds of an id-based module only (absent otherwise). */
  outcome?: MigrateOutcome;
  /** Requested ids that did not change on the target (skipped or UNCHANGED). */
  unchanged?: string[];
}

export interface MigrateStatusData {
  action: "status";
  build: BuildInfo;
}

export interface MigrateLogsData {
  action: "logs";
  buildNumber: number;
  consoleText: string;
  truncated: boolean;
}
