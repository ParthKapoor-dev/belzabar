export type YesNo = "Y" | "N";

export type MigrationModule = "PD" | "AD";

export type MigrationCleanupMode = "auto" | "never";

export type ProfileSource = "live" | "cache" | "fallback";

export interface NsmProfileResolution {
  profiles: string[];
  source: ProfileSource;
  fetchedAt: string;
  raw?: {
    scannedUrls: string[];
    matchedProfiles: string[];
    errors: string[];
    cachePath: string;
  };
}

export interface StartExecutionInput {
  scriptName: string;
  profile: string;
  moduleName: MigrationModule;
  ids: string[];
  useCrud: YesNo;
  isAsync: YesNo;
  migrateDependents: YesNo;
  migrationId?: string;
}

export interface StartExecutionResult {
  executionId: string;
  status: number;
  body: string;
  cookieHeader?: string;
}

export interface CleanupExecutionResult {
  status?: number;
  ok: boolean;
  error?: string;
}

export interface StreamExecutionEvent {
  raw: string;
  event?: string;
  data?: string;
}

export interface StreamExecutionResult {
  executionId: string;
  events: StreamExecutionEvent[];
  outputText: string;
  closeCode?: number;
  closeReason?: string;
}

export interface ReportSummary {
  migrationId?: string;
  migrationStatus?: string;
  statusCode?: number;
  entityCount: number;
  mismatchCount: number;
  successCount: number;
  failedCount: number;
}

export interface ParsedMigrationOutput {
  cleanedOutput: string;
  successDetected: boolean;
  failureDetected: boolean;
  failureHints: string[];
  runId?: string;
  migrationId?: string;
  statusUrl?: string;
  detailsUrl?: string;
  sourceHost?: string;
  targetHost?: string;
  reportSummary?: ReportSummary;
  rawReport?: unknown;
}

export interface ArtifactWriteInput {
  summary: unknown;
  outputText: string;
  events?: StreamExecutionEvent[];
}

export interface ArtifactWriteResult {
  summaryPath: string;
  streamPath: string;
  eventsPath?: string;
}

export interface MigrateProfilesArgs {
  action: "profiles";
  refresh: boolean;
  raw: boolean;
}

export interface MigrateRunArgs {
  action: "run";
  moduleName: MigrationModule;
  ids: string[];
  profile?: string;
  sourceEnv?: string;
  targetEnv?: string;
  useCrud: YesNo;
  isAsync: YesNo;
  migrateDependents: YesNo;
  cleanup: MigrationCleanupMode;
  scriptName: string;
  migrationId?: string;
  outPath?: string;
  raw: boolean;
  quiet?: boolean;
}

export type MigrateArgs = MigrateProfilesArgs | MigrateRunArgs;

export interface MigrateProfilesData {
  action: "profiles";
  source: ProfileSource;
  fetchedAt: string;
  profiles: string[];
  raw?: NsmProfileResolution["raw"];
}

export interface MigrateRunData {
  action: "run";
  moduleName: MigrationModule;
  profile: string;
  profileSource: ProfileSource;
  ids: string[];
  request: {
    scriptName: string;
    useCrud: YesNo;
    isAsync: YesNo;
    migrateDependents: YesNo;
    migrationId?: string;
  };
  execution: {
    executionId: string;
    success: boolean;
    runId?: string;
    migrationId?: string;
    statusUrl?: string;
    detailsUrl?: string;
    sourceHost?: string;
    targetHost?: string;
    failureHints: string[];
    cleanup: CleanupExecutionResult;
  };
  report?: ReportSummary;
  artifacts?: ArtifactWriteResult;
  raw?: {
    start: StartExecutionResult;
    streamEvents: StreamExecutionEvent[];
    parsedOutput: ParsedMigrationOutput;
  };
}

export type MigrateData = MigrateProfilesData | MigrateRunData;
