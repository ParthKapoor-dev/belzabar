import type { JenkinsClient, MigrateType } from "./constants";

export type YesNo = "Y" | "N";

export type ProfileSource = "live" | "cache";

export interface JenkinsParameterDefinition {
  name: string;
  type: string;
  description?: string;
  defaultValue?: string | boolean;
  choices?: string[];
}

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

export interface TriggerBuildInput {
  client: JenkinsClient;
  profile: string;
  migrateType: MigrateType | string;
  ids: string[];
  migrationId?: string;
  asyncMigration: YesNo;
  migrateDependent: YesNo;
  devopsTag?: string;
  dryRun?: boolean;
  autoApprove?: boolean;
}

export interface QueueItem {
  id: number;
  url: string;
  why?: string;
  executable?: { number: number; url: string };
  cancelled?: boolean;
}

export interface BuildInfo {
  number: number;
  url: string;
  building: boolean;
  result: "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | null;
  duration: number;
  timestamp: number;
  estimatedDuration: number;
  actions: Array<{ parameters?: Array<{ name: string; value: unknown }> }>;
}

export interface ConsoleChunk {
  text: string;
  nextOffset: number;
  hasMore: boolean;
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
