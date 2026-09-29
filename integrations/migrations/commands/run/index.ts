import { CliError, type CommandContext, type CommandModule, Config, confirmWrite, ok } from "@belzabar/core";
import {
  assertJenkinsAuth,
  buildUrl,
  resolveClientForProfile,
  getBuild,
  jobUrl,
  parseJenkinsConsole,
  parseMigrateRunArgs,
  RUN_ARGS,
  resolveMigrationTargets,
  resolveQueueItem,
  streamConsole,
  triggerBuild,
  writeArtifacts,
} from "../../lib";
import type { MigrateRunArgs, MigrateRunData, TriggerBuildInput } from "../../lib";

export const args = RUN_ARGS;

function logProgress(quiet: boolean | undefined, line: string): void {
  if (quiet) return;
  process.stderr.write(`[migrate] ${line}\n`);
}

const command: CommandModule<MigrateRunArgs, MigrateRunData> = {
  schema: "belz.migrate.run",
  /** Triggers a Jenkins migration build. */
  writes: true,
  async parseArgs(argv) {
    return await parseMigrateRunArgs(argv);
  },
  async execute(args, context) {
    const auth = assertJenkinsAuth(Config.getJenkins());
    const isHuman = context.outputMode === "human";
    const showProgress = isHuman && !args.quiet;

    if (showProgress) logProgress(args.quiet, "Resolving profile + client…");
    const profile = args.profile as string;
    let client = args.client;
    if (client) {
      // OTH-R26: an explicit --client must be the profile's Jenkins group, or
      // the build runs with the wrong CLIENT. An unlisted profile is left to
      // the explicit client (that is what --client is for).
      const { client: expected } = await resolveClientForProfile(auth, profile);
      if (expected && expected.toLowerCase() === client.toLowerCase()) client = expected; // Jenkins' spelling
      else if (expected) {
        throw new CliError(
          `--client '${client}' does not match profile '${profile}', which belongs to Jenkins client '${expected}'.`,
          { code: "MIGRATE_CLIENT_PROFILE_MISMATCH", details: { profile, client, expected } },
        );
      }
    } else {
      // A miss against the cached list re-fetches from Jenkins once (MG-4).
      ({ client } = await resolveClientForProfile(auth, profile));
      if (!client) {
        throw new CliError(
          `Profile '${profile}' not found in any Jenkins client group. Pass --client explicitly or check 'belz migrate profiles'.`,
          { code: "MIGRATE_PROFILE_NOT_FOUND", details: { profile } }
        );
      }
    }

    // Pre-flight: resolve every id against the SOURCE environment before the
    // build is triggered. A PD draft id is not migratable (the migration
    // service 500s on draft ids) — resolve it to its published sibling here,
    // and surface the human-readable name of every entity being migrated.
    if (showProgress) logProgress(args.quiet, "Resolving ids on the source environment…");
    const preflight = await resolveMigrationTargets({
      sourceEnv: args.sourceEnv,
      profile,
      migrateType: String(args.migrateType),
      ids: args.ids,
      // A skipped pre-flight is surfaced (envelope meta.warnings), and shown
      // immediately in human mode since the build follows right after.
      warn: (message) => {
        context.warn(message);
        if (showProgress) logProgress(args.quiet, `WARNING: ${message}`);
      },
    });
    const effectiveIds = preflight ? preflight.resolvedIds : args.ids;
    if (preflight && showProgress) {
      for (const t of preflight.targets) {
        const swap = t.swapped ? `  ⤷ draft ${t.inputId} → published` : "";
        logProgress(args.quiet, `  • ${t.name} [${t.kind}] ${t.resolvedId}${swap}`);
      }
    }

    const input: TriggerBuildInput = {
      client,
      profile,
      migrateType: args.migrateType,
      ids: effectiveIds,
      migrationId: args.migrationId,
      asyncMigration: args.asyncMigration,
      migrateDependent: args.migrateDependent,
      devopsTag: args.devopsTag,
      dryRun: args.dryRun,
      autoApprove: args.autoApprove,
    };

    // Every run is a real Jenkins build (a dry run too): confirm first.
    await requireRunConfirmation(context, args.yes === true, `trigger a Jenkins migration build (${auth.job})`, [
      ["Profile", profile],
      ["Client", String(client)],
      ["Module", String(args.migrateType)],
      ["Ids", preflight ? preflight.targets.map((t) => `${t.name} ${t.resolvedId}`).join(", ") : effectiveIds.join(", ")],
      ["Dry run", args.dryRun ? "yes (DRY_RUN=true, still a real build)" : "no"],
    ]);

    if (showProgress) logProgress(args.quiet, `Triggering ${auth.job} (client=${client}, profile=${profile})…`);
    let trigger: { queueUrl: string };
    try {
      trigger = await triggerBuild(auth, input);
    } catch (e) {
      // Jenkins accepted the POST (2xx) but sent no queue Location: a build IS
      // queued, we just can't follow it (OTH-R23).
      if (e instanceof CliError && e.code === "MIGRATE_JENKINS_NO_QUEUE_LOCATION") {
        throw withBuildRef(e, { jobUrl: jobUrl(auth) });
      }
      throw e;
    }

    // From here on a build exists. Every failure carries its reference so an
    // agent checks `migrate status` instead of re-running (OTH-R23).
    let buildNumber: number | undefined;
    try {
      if (showProgress) logProgress(args.quiet, "Waiting for build assignment…");
      const queue = await resolveQueueItem(auth, trigger.queueUrl, {
        onWait: (item) => {
          if (showProgress && item.why) logProgress(args.quiet, `Queue: ${item.why}`);
        },
      });
      buildNumber = queue.executable?.number as number;
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
        resolvedTargets: preflight?.targets,
        resolvedSourceEnv: preflight?.sourceEnv,
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
    } catch (e) {
      throw withBuildRef(e, {
        jobUrl: jobUrl(auth),
        queueUrl: trigger.queueUrl,
        buildNumber,
        buildUrl: buildNumber !== undefined ? buildUrl(auth, buildNumber) : undefined,
      });
    }
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

    if (data.resolvedTargets && data.resolvedTargets.length > 0) {
      ui.section(`Targets — resolved on ${data.resolvedSourceEnv ?? "source env"}`);
      ui.table(
        ["Name", "Kind", "Migrated id", "Note"],
        data.resolvedTargets.map((t) => [
          t.name,
          t.kind,
          t.resolvedId,
          t.swapped ? `draft ${t.inputId} → published` : t.status ?? "",
        ]),
      );
    }

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

/**
 * `migrate run` has no --env to gate it (the profile names the envs), so the
 * build itself is confirmed: --yes proceeds, an interactive terminal is asked,
 * --llm or a non-TTY without --yes is MIGRATE_CONFIRMATION_REQUIRED.
 */
async function requireRunConfirmation(
  context: Pick<CommandContext, "outputMode">,
  yes: boolean,
  action: string,
  details: Array<[string, string]>,
): Promise<void> {
  await confirmWrite({
    yes,
    outputMode: context.outputMode,
    action,
    details,
    codePrefix: "MIGRATE",
    requiredMessage: `Confirmation required to ${action}. Pass --yes to proceed.`,
    promptMessage: "Trigger the build?",
    refuseWithoutTty: true,
    abortExitCode: 130,
    detailsShape: "object",
    emptyBody: "",
  });
}

/**
 * Re-throw a failure that happened AFTER the build was triggered with the
 * build's reference in `details` (buildTriggered, buildNumber, buildUrl,
 * queueUrl, jobUrl) and, unless the build itself failed, a do-not-retrigger
 * hint in the message. Keeps the original code and exit code (OTH-R23).
 */
function withBuildRef(
  e: unknown,
  ref: { jobUrl: string; queueUrl?: string; buildNumber?: number; buildUrl?: string },
): CliError {
  const cli = e instanceof CliError ? e : null;
  const code = cli?.code ?? "MIGRATE_RUN_INTERRUPTED";
  const message = e instanceof Error ? e.message : String(e);
  const where = ref.buildNumber !== undefined
    ? `build #${ref.buildNumber} (${ref.buildUrl}); check it with 'belz migrate status ${ref.buildNumber}'`
    : ref.queueUrl ? `queue item ${ref.queueUrl}; find the build on ${ref.jobUrl}` : `a build on ${ref.jobUrl}`;
  const hint = code === "MIGRATE_RUN_FAILED" ? "" : ` A build WAS triggered — do NOT re-run 'migrate run'; ${where}.`;
  const prior = cli && typeof cli.details === "object" && cli.details !== null && !Array.isArray(cli.details)
    ? (cli.details as Record<string, unknown>) : {};
  const details: Record<string, unknown> = { ...prior, buildTriggered: true, jobUrl: ref.jobUrl };
  if (ref.queueUrl) details.queueUrl = ref.queueUrl;
  if (ref.buildNumber !== undefined) {
    details.buildNumber = ref.buildNumber;
    details.buildUrl = ref.buildUrl;
  }
  return new CliError(`${message}${hint}`, { code, exitCode: cli?.exitCode ?? 1, details });
}
