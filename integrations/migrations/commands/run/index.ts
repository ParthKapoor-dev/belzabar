import { CliError, type CommandModule, Config, confirmWrite, isObj, ok } from "@belzabar/core";
import {
  assertJenkinsAuth,
  buildUrl,
  cacheCommandHint,
  checkLanding,
  clearTargetCache,
  failedEntitiesOf,
  readFailureReasons,
  statusModuleFor,
  envPairFromProfile,
  resolveClientForProfile,
  getBuild,
  jobUrl,
  migrationOutcome,
  parseJenkinsConsole,
  parseMigrateRunArgs,
  RUN_ARGS,
  resolveMigrationTargets,
  resolveQueueItem,
  streamConsole,
  triggerBuild,
  writeArtifacts,
} from "../../lib";
import type { BackgroundCheck, MigrateRunArgs, MigrateRunData, TriggerBuildInput } from "../../lib";

export const args = RUN_ARGS;

function logProgress(quiet: boolean | undefined, line: string): void {
  if (quiet) return;
  process.stderr.write(`[migrate] ${line}\n`);
}

const command: CommandModule<MigrateRunArgs, MigrateRunData> = {
  /** Triggers a Jenkins migration build. */
  writes: true,
  async parseArgs(argv) {
    return await parseMigrateRunArgs(argv);
  },
  async execute(args, context) {
    const auth = assertJenkinsAuth(Config.getJenkins());
    // Progress goes to stderr in every mode (stdout keeps the envelope): a
    // build runs for minutes and an agent must see it is alive.
    const showProgress = !args.quiet;

    if (showProgress) logProgress(args.quiet, "Resolving profile + client…");
    const profile = args.profile as string;
    let client = args.client;
    if (client) {
      // An explicit --client must be the profile's Jenkins group, or the build
      // runs with the wrong CLIENT. An unlisted profile is left to the explicit
      // client (that is what --client is for).
      const { client: expected } = await resolveClientForProfile(auth, profile);
      if (expected && expected.toLowerCase() === client.toLowerCase()) client = expected; // Jenkins' spelling
      else if (expected) {
        throw new CliError(
          `--client '${client}' does not match profile '${profile}', which belongs to Jenkins client '${expected}'.`,
          { code: "MIGRATE_CLIENT_PROFILE_MISMATCH", details: { profile, client, expected } },
        );
      }
    } else {
      ({ client } = await resolveClientForProfile(auth, profile));
      if (!client) {
        throw new CliError(
          `Profile '${profile}' not found in any Jenkins client group. Pass --client explicitly or check 'wi-impl migrate profiles'.`,
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

    // Every run is a real Jenkins build (a dry run too), and `migrate` has no
    // --env to gate it (the profile names the envs), so the build itself is
    // confirmed: --yes proceeds, a terminal is asked, --llm or a non-TTY
    // without --yes is MIGRATE_CONFIRMATION_REQUIRED.
    const action = `trigger a Jenkins migration build (${auth.job})`;
    await confirmWrite({
      yes: args.yes === true,
      outputMode: context.outputMode,
      action,
      details: [
        ["Profile", profile],
        ["Client", String(client)],
        ["Module", String(args.migrateType)],
        ["Ids", preflight ? preflight.targets.map((t) => `${t.name} ${t.resolvedId}`).join(", ") : effectiveIds.join(", ")],
        ["Dry run", args.dryRun ? "yes (DRY_RUN=true, still a real build)" : "no"],
      ],
      codePrefix: "MIGRATE",
      requiredMessage: `Confirmation required to ${action}. Pass --yes to proceed.`,
      promptMessage: "Trigger the build?",
      refuseWithoutTty: true,
      abortExitCode: 130,
      detailsShape: "object",
      emptyBody: "",
    });

    if (showProgress) logProgress(args.quiet, `Triggering ${auth.job} (client=${client}, profile=${profile})…`);
    let trigger: { queueUrl: string };
    try {
      trigger = await triggerBuild(auth, input);
    } catch (e) {
      // Jenkins accepted the POST (2xx) but sent no queue Location: a build IS
      // queued, we just can't follow it.
      if (e instanceof CliError && e.code === "MIGRATE_JENKINS_NO_QUEUE_LOCATION") {
        throw withBuildRef(e, { jobUrl: jobUrl(auth) });
      }
      throw e;
    }

    // From here on a build exists. Every failure carries its reference so an
    // agent checks `migrate status` instead of re-running.
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
      // Only a followed, real build of ids has a knowable outcome.
      const realRun = args.follow && !args.dryRun && effectiveIds.length > 0;
      const migrateType = String(args.migrateType);
      const kind = /^AD_Method$/i.test(migrateType) ? "AD" : /^PD$/i.test(migrateType) ? "PD" : null;
      // Background mode (HTTP 206): the script then fails the build, but the
      // ids may still land. Jenkins' FAILURE says nothing about them.
      const background = realRun && parsed.background;
      // --no-follow returns immediately; the build is in flight. Don't treat a
      // pending result as failure — the caller can check later with `migrate status`.
      const success = background || (args.follow
        ? finalResult === "SUCCESS" && !parsed.failureDetected
        : finalResult !== "FAILURE" && finalResult !== "ABORTED");

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

      const pair = envPairFromProfile(profile);
      const sourceEnv = preflight?.sourceEnv ?? args.sourceEnv ?? pair?.sourceEnv;
      const targetEnv = args.targetEnv ?? pair?.targetEnv;
      const nameOf = (id: string): string | undefined =>
        parsed.reportSummary?.entities.find((e) => e.id?.toLowerCase() === id.toLowerCase())?.name
          ?? preflight?.targets.find((t) => t.resolvedId.toLowerCase() === id.toLowerCase())?.name;
      const labelOf = (id: string, name = nameOf(id)) => (name ? `${name} ${id}` : id);

      // Ids whose target copy changed: every id, or only those that landed.
      let changedIds = effectiveIds;
      if (background) {
        if (showProgress) {
          logProgress(args.quiet, "Migration went to background (HTTP 206): Jenkins reports FAILURE, but the ids may still land.");
        }
        const check: BackgroundCheck = kind === "AD"
          ? await (async () => {
            if (showProgress && sourceEnv && targetEnv) logProgress(args.quiet, `Polling ${targetEnv} for the published versions on ${sourceEnv}…`);
            return checkLanding(effectiveIds, sourceEnv, targetEnv, {
              onPoll: (landed, total, waitedMs) => {
                if (showProgress) logProgress(args.quiet, `  landed ${landed}/${total} after ${Math.round(waitedMs / 1000)}s`);
              },
            });
          })()
          : { sourceEnv, targetEnv, landed: [], notLanded: [...effectiveIds], rows: [], waitedMs: 0, skipped: "landing is checked for AD methods only" };
        data.background = check;
        if (check.skipped) {
          data.outcome = "BACKGROUND";
          context.warn(
            `Migration build #${buildNumber} went to background mode (HTTP 206); whether the ids landed was not checked (${check.skipped}). ` +
              `Compare each id on ${targetEnv ?? "the target"} with the source before re-running.`,
          );
        } else {
          changedIds = check.landed;
          data.outcome = check.notLanded.length === 0 ? "MIGRATED" : check.landed.length > 0 ? "PARTIAL" : "NOTHING_MIGRATED";
          data.unchanged = check.notLanded;
          for (const row of check.rows.filter((r) => !r.landed)) {
            context.warn(
              `${labelOf(row.id, row.name)}: not on ${targetEnv} after ${Math.round(check.waitedMs / 1000)}s ` +
                `(source version ${row.sourceVersion ?? "?"}, target ${row.targetVersion ?? "none"}${row.error ? `; ${row.error}` : ""}). ` +
                `The background migration may still finish: check with 'wi-impl ad show ${row.id} --env ${targetEnv}' before re-running.`,
            );
          }
        }
      }

      // The build wrote the TARGET env: drop wi-impl's cached copies there so the
      // next `ad show` / `pd show --env <target>` reads fresh, and clear the
      // target server's AD cache. Best effort, once the build is over.
      if (realRun && targetEnv && kind && changedIds.length > 0) {
        if (showProgress) logProgress(args.quiet, `Clearing the cache of ${changedIds.length} id(s) on ${targetEnv}…`);
        const cleared = await clearTargetCache(kind, targetEnv, changedIds, {
          onRound: (round, of) => {
            if (showProgress) logProgress(args.quiet, `  server cache round ${round.round}/${of}: ${round.ok ? "sent" : "FAILED"}`);
          },
        });
        data.cacheInvalidated = { env: targetEnv, ids: cleared.local };
        if (cleared.server) {
          data.serverCache = cleared.server;
          const hint = cacheCommandHint(targetEnv, changedIds);
          if ("skipped" in cleared.server) context.warn(`Target server cache NOT cleared (${cleared.server.skipped}). Clear it with: ${hint}`);
          else if (!cleared.server.verified) {
            context.warn(
              `Target server cache: only ${cleared.server.okRounds} of ${cleared.server.rounds.length} clear rounds reached ${targetEnv}; ` +
                `some servers may still run the old version. Repeat it: ${hint}`,
            );
          }
        }
      }

      // A FAILED entity fails the run even when Jenkins says SUCCESS. Its
      // reason is in the console (`FAILED ITEM`) or, when only the report row
      // says FAILED, in the service's status: read through a status build.
      if (realRun && !background) {
        const failed = failedEntitiesOf(parsed);
        const missing = failed.filter((f) => !f.reason);
        const statusModule = statusModuleFor(migrateType);
        const migrationId = parsed.migrationId ?? parsed.reportSummary?.migrationId;
        if (missing.length > 0 && statusModule && migrationId) {
          if (showProgress) logProgress(args.quiet, `${missing.length} entit${missing.length === 1 ? "y" : "ies"} FAILED without a reason: reading it with a ${statusModule} build…`);
          const { ref, items } = await readFailureReasons(auth, { client: input.client, profile, devopsTag: input.devopsTag }, statusModule, migrationId, missing.map((m) => m.id), {
            onProgress: (line) => { if (showProgress) logProgress(args.quiet, line); },
          });
          data.statusBuild = ref;
          for (const f of missing) {
            const item = items.find((i) => i.id === f.id);
            if (item?.reason) Object.assign(f, { reason: item.reason, kind: f.kind ?? item.kind, reasonFrom: "status-build" as const });
          }
          if (ref.error) context.warn(`Could not read the failure reason from a ${statusModule} build: ${ref.error}`);
        }
        for (const f of failed) f.name ??= nameOf(f.id);
        if (failed.length > 0) data.failedEntities = failed;
      }

      // A build can finish SUCCESS and change nothing: the script skips a
      // method whose version is the same on both sides (the report says
      // UNCHANGED).
      if (success && realRun && !background) {
        const { outcome, unchanged } = migrationOutcome(effectiveIds, parsed);
        data.outcome = outcome;
        data.unchanged = unchanged;
        for (const id of unchanged) {
          const skip = parsed.skipped.find((s) => s.id === id);
          const label = labelOf(id);
          context.warn(skip
            ? `${label}: skipped, same version${skip.version !== undefined ? ` ${skip.version}` : ""} on source and target. ` +
              "Target PUBLISHED is unchanged, and the target DRAFT may have been overwritten. Bump the source version (publish again) and re-run."
            : `${label}: UNCHANGED on the target (the migration report lists it but did not migrate it).`);
        }
      }

      if (args.outPath) {
        if (showProgress) logProgress(args.quiet, `Writing artifacts to ${args.outPath}…`);
        data.artifacts = await writeArtifacts(args.outPath, {
          summary: data,
          consoleText: parsed.cleanedOutput,
        });
      }

      const failedText = (data.failedEntities ?? [])
        .map((f) => `${labelOf(f.id, f.name)}${f.kind ? ` (${f.kind})` : ""}: ${f.reason ?? "no reason given"}`)
        .join("; ");
      if (!success) {
        throw new CliError(
          `Migration build #${buildNumber} did not complete successfully (result=${finalResult}).` +
            (failedText ? ` Failed: ${failedText}` : ""),
          {
            code: "MIGRATE_RUN_FAILED",
            details: {
              buildUrl: data.buildUrl,
              result: finalResult,
              failureHints: parsed.failureHints,
              report: parsed.reportSummary,
              ...(data.failedEntities ? { failedEntities: data.failedEntities } : {}),
              ...(data.statusBuild ? { statusBuild: data.statusBuild } : {}),
            },
          },
        );
      }

      if (data.failedEntities) {
        throw new CliError(
          `Migration build #${buildNumber} finished ${finalResult}, but ${data.failedEntities.length} entit` +
            `${data.failedEntities.length === 1 ? "y" : "ies"} FAILED: ${failedText}`,
          {
            code: "MIGRATE_ENTITY_FAILED",
            details: {
              buildUrl: data.buildUrl,
              result: finalResult,
              failedEntities: data.failedEntities,
              ...(data.statusBuild ? { statusBuild: data.statusBuild } : {}),
              report: parsed.reportSummary,
            },
          },
        );
      }

      if (args.strict && data.outcome && data.outcome !== "MIGRATED") {
        const nothing = data.outcome === "NOTHING_MIGRATED" || data.outcome === "BACKGROUND";
        throw new CliError(
          `Migration build #${buildNumber} finished ${background ? "in background mode" : finalResult} but ` +
            `${nothing ? "migrated nothing (that wi-impl could confirm)" : "left some ids unchanged"}` +
            ` (--strict): ${data.unchanged?.join(", ") || "no entity COMPLETED"}.`,
          {
            code: nothing ? "MIGRATE_NOTHING_MIGRATED" : "MIGRATE_PARTIALLY_MIGRATED",
            details: { buildUrl: data.buildUrl, outcome: data.outcome, unchanged: data.unchanged, skipped: parsed.skipped, report: parsed.reportSummary },
          },
        );
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
    const headline = `Build #${data.buildNumber} ${data.result ?? "completed"} in ${(data.duration / 1000).toFixed(1)}s.`;
    if (data.background) {
      const b = data.background;
      ui.warn(
        `Build #${data.buildNumber} went to background mode (HTTP 206; Jenkins says ${data.result ?? "nothing"}). ` +
          (b.skipped ? `Landing not checked: ${b.skipped}.` : `${b.landed.length}/${b.landed.length + b.notLanded.length} id(s) landed on ${b.targetEnv}.`),
      );
    } else if (data.outcome === "NOTHING_MIGRATED") ui.warn(`${headline} Nothing was migrated: every entity was skipped or UNCHANGED.`);
    else if (data.outcome === "PARTIAL") ui.warn(`${headline} Partially migrated: ${data.unchanged?.length ?? 0} id(s) unchanged.`);
    else ui.success(headline);
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
        ["Outcome", data.outcome ?? ""],
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

    if (data.background && data.background.rows.length > 0) {
      ui.section(`Landing on ${data.background.targetEnv} (polled ${Math.round(data.background.waitedMs / 1000)}s)`);
      ui.table(
        ["Name", "Id", "Source version", "Target version", "Landed"],
        data.background.rows.map((r) => [r.name ?? "", r.id, String(r.sourceVersion ?? ""), String(r.targetVersion ?? ""), r.landed ? "yes" : `no${r.error ? ` (${r.error})` : ""}`]),
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
          ["Unchanged", data.report.unchangedCount],
        ]
      );
      if (data.report.entities.length > 0) {
        ui.table(
          ["Name", "Id", "Status", "Identical"],
          data.report.entities.map((e) => [e.name ?? "", e.id ?? "", e.status ?? "", e.identical === undefined ? "" : String(e.identical)]),
        );
      }
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
 * Re-throw a failure that happened AFTER the build was triggered with the
 * build's reference in `details` (buildTriggered, buildNumber, buildUrl,
 * queueUrl, jobUrl) and, unless the build itself failed, a do-not-retrigger
 * hint in the message. Keeps the original code and exit code.
 */
function withBuildRef(
  e: unknown,
  ref: { jobUrl: string; queueUrl?: string; buildNumber?: number; buildUrl?: string },
): CliError {
  const cli = e instanceof CliError ? e : null;
  const code = cli?.code ?? "MIGRATE_RUN_INTERRUPTED";
  const message = e instanceof Error ? e.message : String(e);
  const where = ref.buildNumber !== undefined
    ? `build #${ref.buildNumber} (${ref.buildUrl}); check it with 'wi-impl migrate status ${ref.buildNumber}'`
    : ref.queueUrl ? `queue item ${ref.queueUrl}; find the build on ${ref.jobUrl}` : `a build on ${ref.jobUrl}`;
  // The build finished: a failed or strict-refused result is not a lost build.
  const finished = code === "MIGRATE_RUN_FAILED" || code === "MIGRATE_ENTITY_FAILED" ||
    code === "MIGRATE_NOTHING_MIGRATED" || code === "MIGRATE_PARTIALLY_MIGRATED";
  const hint = finished ? "" : ` A build WAS triggered — do NOT re-run 'migrate run'; ${where}.`;
  const prior = cli && isObj(cli.details) ? cli.details : {};
  const details: Record<string, unknown> = { ...prior, buildTriggered: true, jobUrl: ref.jobUrl };
  if (ref.queueUrl) details.queueUrl = ref.queueUrl;
  if (ref.buildNumber !== undefined) {
    details.buildNumber = ref.buildNumber;
    details.buildUrl = ref.buildUrl;
  }
  return new CliError(`${message}${hint}`, { code, exitCode: cli?.exitCode ?? 1, details });
}
