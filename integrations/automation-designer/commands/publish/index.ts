import { CliError, type CommandModule, defineArgs, isObj, ok, printErr } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { resolveMethodRef } from "@belzabar/core/platform";
import { AD_YES_FLAG } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { fingerprintMethod } from "../../lib/fingerprint";
import * as v2 from "../../lib/api/v2";
import { VALIDATION_FLAGS } from "../../lib/save/flags";
import { runValidationGate, type ValidationSummary } from "../../lib/save/validation";
import { invalidateCompiledCache, type CompiledCacheResult } from "../../lib/save/compiled-cache";
import { forgetContract } from "../../lib/validate/online";
import { assertDraftUnchanged } from "../../lib/save/pipeline";
import {
  findRemovedInputCallers,
  readSuitesBeforePublish,
  removedInputs,
  reportPublishedSuite,
  type PublishedSuiteReport,
  type RemovedInputCallers,
  type SuitesBeforePublish,
} from "../../lib/publish-report";

interface PublishArgs {
  uuid: string;
  yes: boolean;
  note: string;
  noValidate: boolean;
  strict: boolean;
  dryRunCompile: boolean;
  allowPreexisting: boolean;
}

interface PublishData {
  draftUuid: string;
  publishedUuid: string;
  draftVersion: number | string;
  publishedVersion: number | string | null;
  /** Logic fingerprint of the draft == the published body after the publish (null if unreadable). */
  inSync: boolean | null;
  switchedFromPublished: boolean;
  changeNote: string;
  /**
   * The change note was read back from the changelog of the draft AND of the
   * published copy (it is posted AFTER the publish, with retries, on both:
   * the server copies the draft's changelog onto the published copy only
   * when publishing).
   */
  noteRecorded: boolean;
  /** Changelog entry id of the note on the draft chain (null when not found). */
  changelogId: string | null;
  /** The draft's numeric chain id. */
  noteChainId: number;
  /** Changelog entry id of the note on the published chain (null when not found). */
  publishedChangelogId: string | null;
  /** The published copy's numeric chain id (null when unreadable). */
  publishedNoteChainId: number | null;
  noteError?: string;
  /**
   * What the publish did to the published test suite: the server replaces it
   * with a copy of the draft's (new suite and case ids; published-only cases
   * deleted). null when a suite could not be read (`testSuiteError`).
   */
  testSuite: PublishedSuiteReport | null;
  testSuiteError?: string;
  /**
   * Inputs the published copy had that the draft dropped. The platform removes
   * them from every caller step, drafts and published copies alike.
   */
  removedInputs?: { keys: string[]; callers: RemovedInputCallers["callers"]; unscannedMethods?: number; error?: string };
  /** Validator result on the draft (pre-existing = also found in the current published copy). */
  validation: ValidationSummary;
  /** Compiled-chain cache eviction for the draft and published uuids (both routes). */
  compiledCache: CompiledCacheResult;
}

export const args = defineArgs({
  command: "wi-impl ad publish",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing <uuid> argument." }],
  flags: {
    ...AD_YES_FLAG,
    ...VALIDATION_FLAGS,
    "allow-preexisting": { type: "boolean", description: "Publish even if the published copy already has the same validator errors" },
    note: {
      type: "string",
      required: true,
      missingCode: "MISSING_CHANGE_NOTE",
      missingMessage: 'A change note is required before publishing. Pass --note "<what changed>".',
    },
  },
});

const command: CommandModule<PublishArgs, PublishData> = {
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return {
      uuid: positionals.uuid,
      yes: flags.yes,
      note: flags.note.trim(),
      noValidate: flags.noValidate,
      strict: flags.strict,
      dryRunCompile: flags.dryRunCompile,
      allowPreexisting: flags.allowPreexisting,
    };
  },
  async execute({ uuid, yes, note, noValidate, strict, dryRunCompile, allowPreexisting }, context) {
    // A publish can take minutes: say what it is doing on stderr (also with --llm).
    const stage = (msg: string) => printErr(`[wi-impl ad publish] ${msg}`);
    const env = context.env.name;
    const guard = await resolveDraftTarget(resolveMethodRef(uuid), "v1");
    if (!guard.ok) {
      throw new CliError(guard.message, {
        code: `AD_DRAFT_GUARD_${guard.reason}`,
        details: guard,
      });
    }
    const draft = guard.draft;

    if (typeof draft.numericId !== "number") {
      throw new CliError(
        `Could not resolve the numeric chain id for ${draft.uuid} — cannot record the change note.`,
        { code: "AD_CHAIN_ID_UNAVAILABLE", details: { uuid: draft.uuid } },
      );
    }

    // Publish does no server-side validation (a broken draft publishes with
    // 200 and fails every run): validate the draft body first. Findings also
    // present in the current published copy are "pre-existing": a pre-existing
    // ERROR blocks too unless --allow-preexisting; a pre-existing warning
    // never blocks (C7: its rule's catalogue severity may be "error", e.g. CC1
    // JAVA or CC5 NODEJS_LAMBDA are reported as warnings).
    stage(`validating draft ${draft.uuid}…`);
    const draftBody = await v2.fetchRawMethod(draft.uuid);
    const publishedBody = guard.publishedUuid ? await v2.fetchRawMethod(guard.publishedUuid).catch(() => undefined) : undefined;
    const validation = await runValidationGate(
      { noValidate, strict, dryRunCompile },
      {
        after: draftBody,
        before: publishedBody,
        env,
        action: "publish",
        preexistingFlag: "--allow-preexisting",
        warn: (msg) => context.warn(msg),
        extraBlocking: (r) =>
          allowPreexisting ? [] : r.warnings.filter((w) => w.preexisting && w.originalSeverity === "error"),
      },
    );

    // C5: inputs the draft dropped are removed from every caller step by the platform.
    const removedKeys = publishedBody ? removedInputs(draftBody, publishedBody) : [];
    let removed: PublishData["removedInputs"];
    if (removedKeys.length) {
      stage(`finding callers that pass the removed input(s) ${removedKeys.join(", ")}…`);
      try {
        const found = await findRemovedInputCallers(draft.uuid, removedKeys);
        removed = { keys: removedKeys, callers: found.callers, ...(found.unscannedMethods ? { unscannedMethods: found.unscannedMethods } : {}) };
      } catch (e) {
        removed = { keys: removedKeys, callers: [], error: e instanceof Error ? e.message : String(e) };
      }
      const lines = removed.callers.map((c) => `${c.category}/${c.name} (${c.state} ${c.uuid}) step ${c.step}: ${c.inputs.join(", ")}`);
      context.warn(
        `The draft drops input(s) ${removedKeys.join(", ")}; publishing removes them from every caller step, ` +
          `PUBLISHED callers included, which then stop passing them until republished. ` +
          (removed.error
            ? `Callers could not be listed (${removed.error}); check with: wi-impl ad callers ${draft.uuid} --env ${env}`
            : lines.length
              ? `Caller steps that pass them: ${lines.join("; ")}.`
              : `No caller step passes them${removed.unscannedMethods ? ` (${removed.unscannedMethods} methods in other categories not scanned: wi-impl ad callers ${draft.uuid} --all)` : ""}.`),
      );
    }

    // A9: the publish replaces the published suite with a copy of the draft's.
    stage("reading the draft and published test suites…");
    let suites: SuitesBeforePublish | null = null;
    let testSuiteError: string | undefined;
    try {
      suites = await readSuitesBeforePublish(draft.uuid, guard.publishedUuid ?? undefined);
    } catch (e) {
      testSuiteError = e instanceof Error ? e.message : String(e);
    }
    if (suites?.publishedOnly.length) {
      context.warn(
        `The published suite has ${suites.publishedOnly.length} test case(s) the draft does not: ` +
          `${suites.publishedOnly.map((c) => `${c.name} (${c.id})`).join(", ")}. Publishing copies the draft's suite over the ` +
          `published one, so they will be deleted. Back them up first: wi-impl ad test-case export ${guard.publishedUuid} --env ${env} > backup.json`,
      );
    }

    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `publish draft ${draft.uuid} to production`,
      details: [
        ["Method", draft.name],
        ["Draft UUID", draft.uuid],
        ["Current published UUID", guard.publishedUuid ?? "(none — first publish)"],
        ["Draft version", String(draft.version)],
        ["Change note", note],
        ["Validation", validation.skipped ? "SKIPPED (--no-validate)" : `${validation.warnings.length} warning(s)`],
        ...(suites
          ? [["Test suite", `published suite replaced by the draft's ${suites.draftCases.length} case(s)` +
              (suites.publishedOnly.length ? `; DELETES ${suites.publishedOnly.length} published-only case(s): ${suites.publishedOnly.map((c) => c.name).join(", ")}` : "")] as [string, string]]
          : []),
        ...(removed ? [["Removed inputs", `${removed.keys.join(", ")}: ${removed.callers.length} caller step(s) pass them`] as [string, string]] : []),
      ],
    });

    // the confirmation can wait indefinitely; publish only the body
    // that was validated. Anything else moving on the draft is a conflict.
    await assertDraftUnchanged(
      draft.uuid,
      draftBody,
      "Nothing was published; re-run the publish so the current draft is validated.",
    );

    // publish FIRST, then record the note. A failed publish must not
    // leave an orphan note claiming a change that never shipped.
    stage("publishing (the server can take a minute or two)…");
    logIntent("POST", `/rest/api/automation/chain/${draft.uuid}/publish`, { draftUuid: draft.uuid });
    let publishedUuid: string;
    try {
      ({ publishedUuid } = await adApi.publishDraft(draft.uuid));
    } catch (e) {
      throw publishTimeoutHint(e, draft.uuid, env);
    }
    stage("evicting the compiled cache…");
    const compiledCache = await invalidateCompiledCache([draft.uuid, publishedUuid]);
    // Its inputs / outputs may have changed: callers' saves must not check against the cached contract.
    const service = draftBody.metadata?.service?.name;
    if (typeof service === "string" && typeof draftBody.name === "string") await forgetContract(service, draftBody.name);
    if (!compiledCache.ok) {
      context.warn(
        `Compiled-cache eviction failed on every route; the published method may run the previous body. ` +
          `Retry with: wi-impl cache ${publishedUuid} --env ${env} --yes`,
      );
    }

    stage("recording the change note…");
    const noteResult = await recordNote(draft.numericId, draft.uuid, publishedUuid, note);
    if (!noteResult.recorded) {
      context.warn(
        `Published, but the change note was NOT recorded (${noteResult.error})` +
          (noteResult.onDraft
            ? "."
            : `. Record it with: wi-impl ad changelog ${draft.uuid} --note "<text>" --env ${env} --yes`),
      );
    }

    stage("verifying the published copy and its test suite…");
    let testSuite: PublishedSuiteReport | null = null;
    if (suites) {
      try {
        testSuite = await reportPublishedSuite(suites, publishedUuid);
      } catch (e) {
        testSuiteError = e instanceof Error ? e.message : String(e);
      }
    }
    if (testSuite?.removed.length) {
      context.warn(`The publish deleted ${testSuite.removed.length} published test case(s): ${testSuite.removed.map((c) => `${c.name} (${c.id})`).join(", ")}.`);
    }
    if (testSuite && testSuite.previousSuiteId && testSuite.previousSuiteId !== testSuite.suiteId) {
      context.warn(
        `The published test suite was replaced (${testSuite.previousSuiteId} → ${testSuite.suiteId}): published case ids changed ` +
          "(data.testSuite.copied maps previousId → publishedId).",
      );
    }

    // Re-fetch both sides: sync is a logic-fingerprint comparison.
    // V2 on both sides: the sync fingerprint compares V2 bodies (see lib/fingerprint).
    const freshDraft = await adApi.fetchMethod(draft.uuid, "v2");
    let publishedVersion: number | string | null = null;
    let inSync: boolean | null = null;
    try {
      const pub = await adApi.fetchMethod(publishedUuid, "v2");
      publishedVersion = pub.version;
      inSync = fingerprintMethod(pub) === fingerprintMethod(freshDraft);
    } catch {
      publishedVersion = null;
    }

    return ok<PublishData>({
      draftUuid: freshDraft.uuid,
      publishedUuid,
      draftVersion: freshDraft.version,
      publishedVersion,
      inSync,
      switchedFromPublished: guard.switchedFromPublished,
      changeNote: note,
      noteRecorded: noteResult.recorded,
      changelogId: noteResult.id,
      noteChainId: draft.numericId,
      publishedChangelogId: noteResult.publishedId,
      publishedNoteChainId: noteResult.publishedChainId,
      ...(noteResult.error ? { noteError: noteResult.error } : {}),
      validation,
      compiledCache,
      testSuite,
      ...(testSuiteError ? { testSuiteError } : {}),
      ...(removed ? { removedInputs: removed } : {}),
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as PublishData;
    ui.success(`Published draft ${data.draftUuid} → ${data.publishedUuid}`);
    ui.table(
      ["Property", "Value"],
      [
        ["Draft UUID", data.draftUuid],
        ["Published UUID", data.publishedUuid],
        ["Draft version", String(data.draftVersion)],
        ["Published version", String(data.publishedVersion ?? "(unknown)")],
        ["In sync (logic)", data.inSync === null ? "(unknown)" : data.inSync ? "Yes" : "No"],
        ["Change note", data.noteRecorded ? data.changeNote : `NOT RECORDED: ${data.noteError ?? ""}`],
        [
          "Test suite",
          data.testSuite
            ? `${data.testSuite.copied.length} case(s) copied from the draft` +
              (data.testSuite.removed.length ? `; ${data.testSuite.removed.length} removed` : "") +
              (data.testSuite.previousSuiteId !== data.testSuite.suiteId ? `; suite ${data.testSuite.previousSuiteId ?? "(none)"} → ${data.testSuite.suiteId ?? "(none)"}` : "")
            : `(unknown${data.testSuiteError ? `: ${data.testSuiteError}` : ""})`,
        ],
        ...(data.removedInputs ? [["Removed inputs", `${data.removedInputs.keys.join(", ")} (${data.removedInputs.callers.length} caller step(s) passed them)`]] : []),
      ],
    );
  },
};

/** Attempts at recording the post-publish change note. */
export const NOTE_ATTEMPTS = 3;
let noteRetryDelayMs = 1000;
/** Tests only: no back-off sleeps. */
export function __setNoteRetryDelayForTests(ms: number): void {
  noteRetryDelayMs = ms;
}

async function recordNoteWithRetry(
  chainId: number,
  note: string,
): Promise<{ recorded: boolean; id: string | null; error?: string }> {
  let lastError = "";
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= NOTE_ATTEMPTS; attempt++) {
    try {
      const id = await adApi.addChangelog(chainId, note);
      return { recorded: true, id };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // NEW-1: a POST that reached the server (reset / timeout after sending:
      // core marks it mayHaveCompleted, retryable:false) may have created the
      // note. Re-sending would duplicate it: look it up instead, never retry.
      if (e instanceof CliError && isObj(e.details) && (e.details.mayHaveCompleted === true || e.details.retryable === false)) {
        try {
          const id = await adApi.findChangelogNote(chainId, note, startedAt);
          if (id) return { recorded: true, id };
        } catch {
          // unreadable list: report below
        }
        return {
          recorded: false,
          id: null,
          error: `${lastError} The note may have been recorded anyway; check \`wi-impl ad changelog\` before recording it again.`,
        };
      }
      if (attempt < NOTE_ATTEMPTS) await Bun.sleep(noteRetryDelayMs * attempt);
    }
  }
  return { recorded: false, id: null, error: lastError };
}

/**
 * The change note, verified (C6). Posted on the draft chain (the record of
 * the change) and on the published chain: the server copies the draft's
 * changelog onto the published copy only when publishing (live: a note
 * recorded after the publish is missing from `ad changelog <published>` until
 * the next publish, which then replaces the published list with the draft's,
 * so posting on both never duplicates). Then both are read back.
 */
async function recordNote(
  draftChainId: number,
  draftUuid: string,
  publishedUuid: string,
  note: string,
): Promise<{ recorded: boolean; onDraft: boolean; id: string | null; publishedId: string | null; publishedChainId: number | null; error?: string }> {
  const startedAt = Date.now();
  logIntent("POST", `/rest/api/automation/chain/changelog/${draftChainId}`, { chainId: draftChainId });
  const draftPost = await recordNoteWithRetry(draftChainId, note);
  if (!draftPost.recorded) {
    return { recorded: false, onDraft: false, id: null, publishedId: null, publishedChainId: null, error: draftPost.error };
  }
  let publishedChainId: number | null = null;
  let publishedError: string | undefined;
  try {
    const pub = await adApi.fetchMethod(publishedUuid, "v1");
    publishedChainId = typeof pub.numericId === "number" ? pub.numericId : null;
  } catch (e) {
    publishedError = e instanceof Error ? e.message : String(e);
  }
  if (publishedChainId !== null) {
    const already = await adApi.findChangelogNote(publishedChainId, note, startedAt).catch(() => null);
    if (!already) {
      logIntent("POST", `/rest/api/automation/chain/changelog/${publishedChainId}`, { chainId: publishedChainId, published: true });
      const pubPost = await recordNoteWithRetry(publishedChainId, note);
      if (!pubPost.recorded) publishedError = pubPost.error;
    }
  }

  // Read both back; one more read after a pause before calling it missing.
  const readBack = async (chainId: number | null) => (chainId === null ? null : adApi.findChangelogNote(chainId, note, startedAt).catch(() => null));
  let id = await readBack(draftChainId);
  let publishedId = await readBack(publishedChainId);
  if (!id || (publishedChainId !== null && !publishedId)) {
    await Bun.sleep(noteRetryDelayMs);
    id ??= await readBack(draftChainId);
    publishedId ??= await readBack(publishedChainId);
  }
  const problems: string[] = [];
  if (!id) problems.push(`the note was posted but is not in the draft's changelog when read back; check \`wi-impl ad changelog ${draftUuid}\` before recording it again`);
  if (!publishedId) {
    problems.push(
      `it is not in the published copy's changelog${publishedError ? ` (${publishedError})` : ""}; ` +
        `\`wi-impl ad changelog ${publishedUuid}\` shows it after the next publish (the server copies the draft's changelog when publishing)`,
    );
  }
  return {
    recorded: problems.length === 0,
    onDraft: !!id,
    id,
    publishedId,
    publishedChainId,
    ...(problems.length ? { error: problems.join("; ") } : {}),
  };
}

/** A publish the client gave up on may still complete on the server (C26): say how to check before retrying. */
function publishTimeoutHint(e: unknown, draftUuid: string, env: string): unknown {
  const maybeDone = e instanceof CliError && (e.code === "HTTP_TIMEOUT" || (isObj(e.details) && e.details.mayHaveCompleted === true));
  if (!maybeDone) return e;
  const check = `wi-impl ad state ${draftUuid} --env ${env}`;
  return new CliError(
    `${e.message} The publish may still have completed on the server: run \`${check}\` (inSync, published version) before publishing again.`,
    { code: e.code, details: { ...(isObj(e.details) ? e.details : {}), check }, exitCode: e.exitCode },
  );
}

export default command;
