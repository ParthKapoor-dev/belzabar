import type { JenkinsClient, MigrateType } from "./constants";
import type { BuildInfo, TriggerBuildInput } from "@belzabar/jenkins";

export type YesNo = "Y" | "N";

export type ProfileSource = "live" | "cache";

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

export interface ReportSummary {
  migrationId?: string;
  migrationStatus?: string;
  entityCount: number;
  identicalCount: number;
  mismatchCount: number;
  completedCount: number;
  failedCount: number;
}

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
  raw: boolean;
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
  raw: boolean;
  quiet?: boolean;
  follow: boolean;
}

export interface MigrateStatusArgs {
  action: "status";
  buildNumber: number;
}

export interface MigrateLogsArgs {
  action: "logs";
  buildNumber: number;
}

export type MigrateArgs =
  | MigrateProfilesArgs
  | MigrateRunArgs
  | MigrateStatusArgs
  | MigrateLogsArgs;

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

export type MigrateData =
  | MigrateProfilesData
  | MigrateRunData
  | MigrateStatusData
  | MigrateLogsData;
