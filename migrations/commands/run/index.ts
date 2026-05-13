import { CliError, Config, ok, type CommandModule } from "@belzabar/core";
import {
  assertJenkinsAuth,
  buildUrl,
  discoverProfiles,
  findClientForProfile,
  getBuild,
  jobUrl,
  parseJenkinsConsole,
  parseMigrateRunArgs,
  resolveQueueItem,
  streamConsole,
  triggerBuild,
  writeArtifacts,
} from "../../lib";
import type { MigrateRunArgs, MigrateRunData, TriggerBuildInput } from "../../lib";

function logProgress(quiet: boolean | undefined, line: string): void {
  if (quiet) return;
  process.stderr.write(`[migrate] ${line}\n`);
}

const command: CommandModule<MigrateRunArgs, MigrateRunData> = {
  schema: "belz.migrate.run",
  async parseArgs(args) {
    return await parseMigrateRunArgs(args);
  },
  async execute(args, context) {
    const auth = assertJenkinsAuth(Config.getJenkins());
    const isHuman = context.outputMode === "human";
    const showProgress = isHuman && !args.quiet;

    if (showProgress) logProgress(args.quiet, "Resolving profile + client…");
    const profile = args.profile as string;
    let client = args.client;
    if (!client) {
      const resolution = await discoverProfiles(auth);
      client = findClientForProfile(resolution.groups, profile);
      if (!client) {
        throw new CliError(
          `Profile '${profile}' not found in any Jenkins client group. Pass --client explicitly or check 'belz migrate profiles'.`,
          { code: "MIGRATE_PROFILE_NOT_FOUND", details: { profile } }
        );
      }
    }

    const input: TriggerBuildInput = {
      client,
      profile,
      migrateType: args.migrateType,
      ids: args.ids,
      migrationId: args.migrationId,
      asyncMigration: args.asyncMigration,
      migrateDependent: args.migrateDependent,
      devopsTag: args.devopsTag,
      dryRun: args.dryRun,
      autoApprove: args.autoApprove,
    };

    if (showProgress) logProgress(args.quiet, `Triggering ${auth.job} (client=${client}, profile=${profile})…`);
    const trigger = await triggerBuild(auth, input);

    if (showProgress) logProgress(args.quiet, "Waiting for build assignment…");
    const queue = await resolveQueueItem(auth, trigger.queueUrl, {
      onWait: (item) => {
        if (showProgress && item.why) logProgress(args.quiet, `Queue: ${item.why}`);
      },
    });
    const buildNumber = queue.executable?.number as number;
    if (showProgress) logProgress(args.quiet, `Build #${buildNumber} started: ${buildUrl(auth, buildNumber)}`);

    let consoleText = "";
    let finalResult: MigrateRunData["result"] = null;
    let duration = 0;

    if (args.follow) {
      const stream = await streamConsole(auth, buildNumber, {
        onChunk: (chunk) => {
          if (!showProgress) return;
          const last = chunk.trimEnd().split(/\r?\n/g).pop() ?? "";
          if (last) {
            const trimmed = last.length > 120 ? `${last.slice(0, 120)}…` : last;
            logProgress(args.quiet, trimmed);
          }
        },
      });
      consoleText = stream.consoleText;
      finalResult = stream.result;
      duration = stream.duration;
    } else {
      const build = await getBuild(auth, buildNumber);
      finalResult = build.result;
      duration = build.duration;
    }

    const parsed = parseJenkinsConsole(consoleText);
    // --no-follow returns immediately; the build is in flight. Don't treat a
    // pending result as failure — the caller can check later with `migrate status`.
    const success = args.follow
      ? finalResult === "SUCCESS" && !parsed.failureDetected
      : finalResult !== "FAILURE" && finalResult !== "ABORTED";

    const data: MigrateRunData = {
      action: "run",
      jobName: auth.job,
      jobUrl: jobUrl(auth),
      buildNumber,
      buildUrl: buildUrl(auth, buildNumber),
      result: finalResult,
      duration,
      input,
      parsed,
      report: parsed.reportSummary,
    };

    if (args.outPath) {
      if (showProgress) logProgress(args.quiet, `Writing artifacts to ${args.outPath}…`);
      data.artifacts = await writeArtifacts(args.outPath, {
        summary: data,
        consoleText: parsed.cleanedOutput,
      });
    }

    if (!success) {
      throw new CliError(`Migration build #${buildNumber} did not complete successfully (result=${finalResult}).`, {
        code: "MIGRATE_RUN_FAILED",
        details: {
          buildUrl: data.buildUrl,
          result: finalResult,
          failureHints: parsed.failureHints,
          report: parsed.reportSummary,
        },
      });
    }

    return ok(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as MigrateRunData;
    ui.success(`Build #${data.buildNumber} ${data.result ?? "completed"} in ${(data.duration / 1000).toFixed(1)}s.`);
    ui.table(
      ["Property", "Value"],
      [
        ["Job", data.jobName],
        ["Build", `#${data.buildNumber}`],
        ["URL", data.buildUrl],
        ["Result", data.result ?? "(none)"],
        ["Client", data.input.client],
        ["Profile", data.input.profile],
        ["Migrate Type", String(data.input.migrateType)],
        ["IDs", data.input.ids.join(", ") || "(none)"],
        ["Dry Run", data.input.dryRun ? "Yes" : "No"],
        ["Migration ID", data.parsed.migrationId ?? ""],
        ["Source DB", data.parsed.sourceDb ?? ""],
        ["Target DB", data.parsed.targetDb ?? ""],
        ["Source Host", data.parsed.sourceHost ?? ""],
        ["Target Host", data.parsed.targetHost ?? ""],
      ]
    );

    if (data.report) {
      ui.section("Report Summary");
      ui.table(
        ["Property", "Value"],
        [
          ["Migration Status", data.report.migrationStatus ?? ""],
          ["Entities", data.report.entityCount],
          ["Identical", data.report.identicalCount],
          ["Mismatched", data.report.mismatchCount],
          ["Completed", data.report.completedCount],
          ["Failed", data.report.failedCount],
        ]
      );
    }

    if (data.artifacts) {
      ui.section("Artifacts");
      ui.kv("Summary", data.artifacts.summaryPath);
      ui.kv("Console", data.artifacts.consolePath);
    }
  },
};

export default command;
