import { CliError, type CommandModule, defineArgs, isObj, ok } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { resolveMethodRef } from "@belzabar/core/platform";
import { AD_YES_FLAG } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { fingerprintMethod } from "../../lib/fingerprint";
import * as v2 from "../../lib/api/v2";
import { ruleInfo } from "../../lib/validate/index";
import { VALIDATION_FLAGS } from "../../lib/save/flags";
import { runValidationGate, type ValidationSummary } from "../../lib/save/validation";
import { invalidateCompiledCache, type CompiledCacheResult } from "../../lib/save/compiled-cache";
import { assertDraftUnchanged } from "../../lib/save/pipeline";

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
  /** Whether the change note was recorded (it is posted AFTER the publish, with retries). */
  noteRecorded: boolean;
  /** Changelog entry id of the note (null when not recorded or not identifiable). */
  changelogId: string | null;
  /** Chain the note was recorded on (the draft's numeric id; the server mirrors it to the published chain). */
  noteChainId: number;
  noteError?: string;
  /** Validator result on the draft (pre-existing = also found in the current published copy). */
  validation: ValidationSummary;
  /** Compiled-chain cache eviction for the draft and published uuids (both routes). */
  compiledCache: CompiledCacheResult;
}

export const args = defineArgs({
  command: "belz ad publish",
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
    // present in the current published copy are "pre-existing"; they block
    // too unless --allow-preexisting.
    const draftBody = await v2.fetchRawMethod(draft.uuid);
    const publishedBody = guard.publishedUuid ? await v2.fetchRawMethod(guard.publishedUuid).catch(() => undefined) : undefined;
    const validation = await runValidationGate(
      { noValidate, strict, dryRunCompile },
      {
        after: draftBody,
        before: publishedBody,
        env: context.env.name,
        action: "publish",
        warn: (msg) => context.warn(msg),
        extraBlocking: (r) =>
          allowPreexisting ? [] : r.warnings.filter((w) => w.preexisting && ruleInfo(w.rule)?.severity === "error"),
      },
    );

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
      ],
    });

    // ADW-R5: the confirmation can wait indefinitely; publish only the body
    // that was validated. Anything else moving on the draft is a conflict.
    await assertDraftUnchanged(
      draft.uuid,
      draftBody,
      "Nothing was published; re-run the publish so the current draft is validated.",
    );

    // AD-19: publish FIRST, then record the note. A failed publish must not
    // leave an orphan note claiming a change that never shipped.
    logIntent("POST", `/rest/api/automation/chain/${draft.uuid}/publish`, { draftUuid: draft.uuid });
    const { publishedUuid } = await adApi.publishDraft(draft.uuid);
    const compiledCache = await invalidateCompiledCache([draft.uuid, publishedUuid]);
    if (!compiledCache.ok) {
      context.warn(
        `Compiled-cache eviction failed on every route; the published method may run the previous body. ` +
          `Retry with: belz cache ${publishedUuid} --env ${context.env.name} --yes`,
      );
    }

    logIntent("POST", `/rest/api/automation/chain/changelog/${draft.numericId}`, { chainId: draft.numericId });
    const noteResult = await recordNoteWithRetry(draft.numericId, note);
    if (!noteResult.recorded) {
      context.warn(
        `Published, but the change note was NOT recorded (${noteResult.error}). Record it with: ` +
          `belz ad changelog ${draft.uuid} --note "<text>" --env ${context.env.name} --yes`,
      );
    }

    // Re-fetch both sides: sync is a logic-fingerprint comparison (AD-18).
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
      ...(noteResult.error ? { noteError: noteResult.error } : {}),
      validation,
      compiledCache,
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
          error: `${lastError} The note may have been recorded anyway; check \`belz ad changelog\` before recording it again.`,
        };
      }
      if (attempt < NOTE_ATTEMPTS) await Bun.sleep(noteRetryDelayMs * attempt);
    }
  }
  return { recorded: false, id: null, error: lastError };
}

export default command;
