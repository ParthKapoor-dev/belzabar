import { CliError, ok, type CommandModule, type OutputMode } from "@belzabar/core";
import {
  cleanupMigrationExecution,
  DB_MIGRATION_TOOL_BASE_URL,
  discoverNsmProfiles,
  parseMigrationOutput,
  parseMigrateArgs,
  startMigrationExecution,
  streamMigrationExecution,
  writeMigrationArtifacts,
} from "../../lib/migration";
import type {
  CleanupExecutionResult,
  MigrateArgs,
  MigrateData,
  MigrateProfilesData,
  MigrateRunArgs,
  MigrateRunData,
  NsmProfileResolution,
  ParsedMigrationOutput,
  StartExecutionResult,
  StreamExecutionResult,
} from "../../lib/migration";

interface MigrateCommandDeps {
  discoverProfiles: (options?: { refresh?: boolean }) => Promise<NsmProfileResolution>;
  startExecution: (input: {
    scriptName: string;
    profile: string;
    moduleName: "PD" | "AD";
    ids: string[];
    useCrud: "Y" | "N";
    isAsync: "Y" | "N";
    migrateDependents: "Y" | "N";
    migrationId?: string;
  }) => Promise<StartExecutionResult>;
  streamExecution: (
    executionId: string,
    options?: { onOutputChunk?: (chunk: string) => void; headers?: Record<string, string> }
  ) => Promise<StreamExecutionResult>;
  parseOutput: (outputText: string) => ParsedMigrationOutput;
  cleanupExecution: (executionId: string, options?: { cookieHeader?: string }) => Promise<CleanupExecutionResult>;
  writeArtifacts: (outPath: string, input: { summary: unknown; outputText: string; events?: unknown[] }) => Promise<{
    summaryPath: string;
    streamPath: string;
    eventsPath?: string;
  }>;
}

const defaultDeps: MigrateCommandDeps = {
  discoverProfiles: (options) => discoverNsmProfiles(options),
  startExecution: (input) => startMigrationExecution(input),
  streamExecution: (executionId, options) => streamMigrationExecution(executionId, options),
  parseOutput: (outputText) => parseMigrationOutput(outputText),
  cleanupExecution: (executionId, options) => cleanupMigrationExecution(executionId, options),
  writeArtifacts: (outPath, input) => writeMigrationArtifacts(outPath, input),
};

function assertProfileAvailable(profile: string, resolution: NsmProfileResolution): void {
  const exists = resolution.profiles.some((item) => item === profile);
  if (!exists) {
    throw new CliError("Selected profile is not available for NSM migration.", {
      code: "MIGRATE_PROFILE_UNAVAILABLE",
      details: {
        profile,
        availableProfiles: resolution.profiles,
        source: resolution.source,
      },
    });
  }
}

function isRunSuccessful(parsed: ParsedMigrationOutput): boolean {
  const reportCompleted = parsed.reportSummary?.migrationStatus?.toUpperCase() === "COMPLETED";
  if (parsed.failureDetected) return false;
  return parsed.successDetected || reportCompleted;
}

async function executeRun(args: MigrateRunArgs, deps: MigrateCommandDeps, outputMode: OutputMode): Promise<MigrateRunData> {
  const progress = (message: string) => {
    if (outputMode !== "human" || args.quiet) return;
    process.stderr.write(`[migrate] ${message}\n`);
  };

  progress("Resolving NSM migration profiles...");
  const profileResolution = await deps.discoverProfiles();
  const profile = args.profile as string;
  assertProfileAvailable(profile, profileResolution);
  progress(`Using profile '${profile}' (source: ${profileResolution.source}).`);

  progress(`Starting migration execution for module ${args.moduleName} (${args.ids.length} id(s))...`);
  const startResult = await deps.startExecution({
    scriptName: args.scriptName,
    profile,
    moduleName: args.moduleName,
    ids: args.ids,
    useCrud: args.useCrud,
    isAsync: args.isAsync,
    migrateDependents: args.migrateDependents,
    migrationId: args.migrationId,
  });
  progress(`Execution started: ${startResult.executionId}`);
  progress("Connecting to migration websocket stream and sending confirmation...");

  const streamResult = await deps.streamExecution(startResult.executionId, {
    headers: {
      Origin: DB_MIGRATION_TOOL_BASE_URL,
      Referer: `${DB_MIGRATION_TOOL_BASE_URL}/index.html`,
      ...(startResult.cookieHeader ? { Cookie: startResult.cookieHeader } : {}),
    },
    onOutputChunk: (chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return;
      const lines = trimmed.split(/\r?\n/g).filter(Boolean);
      for (const line of lines) {
        if (outputMode !== "human" || args.quiet) continue;
        process.stderr.write(`[migrate:stream] ${line}\n`);
      }
    },
  });
  progress(
    `Websocket closed${streamResult.closeCode ? ` (code ${streamResult.closeCode}${streamResult.closeReason ? `, ${streamResult.closeReason}` : ""})` : ""}.`
  );

  const parsed = deps.parseOutput(streamResult.outputText);

  if (streamResult.events.length === 0 && parsed.cleanedOutput.trim().length === 0) {
    throw new CliError("No migration output was received from websocket stream.", {
      code: "MIGRATE_STREAM_EMPTY",
      details: {
        executionId: startResult.executionId,
        closeCode: streamResult.closeCode,
        closeReason: streamResult.closeReason,
        hint: "Execution may require browser-only websocket behavior, proxy allowances, or origin/cookie compatibility.",
      },
    });
  }

  progress("Migration stream parsed. Finalizing cleanup...");
  const cleanupResult =
    args.cleanup === "auto"
      ? await deps.cleanupExecution(startResult.executionId, {
          cookieHeader: startResult.cookieHeader,
        })
      : { ok: true, error: undefined };
  if (!cleanupResult.ok) {
    progress(`Cleanup request failed (${cleanupResult.error || cleanupResult.status || "unknown"}). Continuing.`);
  }

  const success = isRunSuccessful(parsed);

  const data: MigrateRunData = {
    action: "run",
    moduleName: args.moduleName,
    profile,
    profileSource: profileResolution.source,
    ids: args.ids,
    request: {
      scriptName: args.scriptName,
      useCrud: args.useCrud,
      isAsync: args.isAsync,
      migrateDependents: args.migrateDependents,
      migrationId: args.migrationId,
    },
    execution: {
      executionId: startResult.executionId,
      success,
      runId: parsed.runId,
      migrationId: parsed.migrationId || parsed.reportSummary?.migrationId,
      statusUrl: parsed.statusUrl,
      detailsUrl: parsed.detailsUrl,
      sourceHost: parsed.sourceHost,
      targetHost: parsed.targetHost,
      failureHints: parsed.failureHints,
      cleanup: cleanupResult,
    },
    report: parsed.reportSummary,
  };

  if (args.raw) {
    data.raw = {
      start: startResult,
      streamEvents: streamResult.events,
      parsedOutput: parsed,
    };
  }

  if (args.outPath) {
    progress(`Writing artifacts to '${args.outPath}'...`);
    data.artifacts = await deps.writeArtifacts(args.outPath, {
      summary: data,
      outputText: parsed.cleanedOutput,
      events: args.raw ? streamResult.events : undefined,
    });
  }

  if (!success) {
    throw new CliError("Migration run did not complete successfully.", {
      code: "MIGRATE_RUN_FAILED",
      details: data,
    });
  }

  return data;
}

export function createMigrateCommand(overrides: Partial<MigrateCommandDeps> = {}): CommandModule<MigrateArgs, MigrateData> {
  const deps: MigrateCommandDeps = { ...defaultDeps, ...overrides };

  const command: CommandModule<MigrateArgs, MigrateData> = {
    schema: "belz.migrate",
    parseArgs(args) {
      return parseMigrateArgs(args);
    },
    async execute(args, context) {
      if (args.action === "profiles") {
        const resolution = await deps.discoverProfiles({ refresh: args.refresh });
        const data: MigrateProfilesData = {
          action: "profiles",
          source: resolution.source,
          fetchedAt: resolution.fetchedAt,
          profiles: resolution.profiles,
        };

        if (args.raw) {
          data.raw = resolution.raw;
        }

        return ok(data);
      }

      const runData = await executeRun(args, deps, context.outputMode);
      return ok(runData);
    },
    presentHuman(envelope, ui) {
      if (!envelope.ok) return;

      const data = envelope.data as MigrateData;
      if (data.action === "profiles") {
        ui.success(`Resolved ${data.profiles.length} NSM migration profile(s).`);
        ui.table(
          ["Profile", "Source", "Fetched At"],
          data.profiles.map((profile) => [profile, data.source, data.fetchedAt])
        );

        if (data.raw) {
          ui.section("Raw Discovery");
          ui.object(data.raw);
        }
        return;
      }

      ui.success(`Migration execution ${data.execution.executionId} completed successfully.`);
      ui.table(
        ["Property", "Value"],
        [
          ["Module", data.moduleName],
          ["Profile", data.profile],
          ["IDs", data.ids.join(", ")],
          ["Execution ID", data.execution.executionId],
          ["Migration ID", data.execution.migrationId || ""],
          ["Status URL", data.execution.statusUrl || ""],
          ["Details URL", data.execution.detailsUrl || ""],
          ["Source Host", data.execution.sourceHost || ""],
          ["Target Host", data.execution.targetHost || ""],
          ["Cleanup", data.execution.cleanup.ok ? "ok" : data.execution.cleanup.error || "failed"],
        ]
      );

      if (data.report) {
        ui.section("Report Summary");
        ui.table(
          ["Property", "Value"],
          [
            ["Migration Status", data.report.migrationStatus || ""],
            ["Status Code", data.report.statusCode ?? ""],
            ["Entities", data.report.entityCount],
            ["Mismatches", data.report.mismatchCount],
            ["Successful", data.report.successCount],
            ["Failed", data.report.failedCount],
          ]
        );
      }

      if (data.artifacts) {
        ui.section("Artifacts");
        ui.object(data.artifacts);
      }

      if (data.raw) {
        ui.section("Raw Data");
        ui.object(data.raw);
      }
    },
  };

  return command;
}

export default createMigrateCommand();
