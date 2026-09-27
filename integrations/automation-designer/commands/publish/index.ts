import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { resolveMethodRef } from "../../lib/ids";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { fingerprintMethod } from "../../lib/fingerprint";

interface PublishArgs {
  uuid: string;
  yes: boolean;
  note: string;
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
}

export const args = defineArgs({
  command: "belz ad publish",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing <uuid> argument." }],
  flags: {
    ...AD_COMMON_FLAGS,
    ...AD_YES_FLAG,
    note: {
      type: "string",
      required: true,
      missingCode: "MISSING_CHANGE_NOTE",
      missingMessage: 'A change note is required before publishing. Pass --note "<what changed>".',
    },
  },
});

const command: CommandModule<PublishArgs, PublishData> = {
  schema: "ad.publish",
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "publish", "publish");
    return { uuid: positionals.uuid, yes: flags.yes, note: flags.note.trim() };
  },
  async execute({ uuid, yes, note }, context) {
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
      ],
    });

    // AD-19: publish FIRST, then record the note. A failed publish must not
    // leave an orphan note claiming a change that never shipped.
    logIntent("POST", `/rest/api/automation/chain/${draft.uuid}/publish`, { draftUuid: draft.uuid });
    const { publishedUuid } = await adApi.publishDraft(draft.uuid);

    logIntent("POST", `/rest/api/automation/chain/changelog/${draft.numericId}`, { chainId: draft.numericId });
    const noteResult = await recordNoteWithRetry(draft.numericId, note);
    if (!noteResult.recorded) {
      context.warn(
        `Published, but the change note was NOT recorded (${noteResult.error}). Record it with: ` +
          `belz ad changelog ${draft.uuid} --note "<text>" --env ${context.env.name} --yes`,
      );
    }

    // Re-fetch both sides: sync is a logic-fingerprint comparison (AD-18).
    const freshDraft = await adApi.fetchMethod(draft.uuid, "v1");
    let publishedVersion: number | string | null = null;
    let inSync: boolean | null = null;
    try {
      const pub = await adApi.fetchMethod(publishedUuid, "v1");
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
  for (let attempt = 1; attempt <= NOTE_ATTEMPTS; attempt++) {
    try {
      const id = await adApi.addChangelog(chainId, note);
      return { recorded: true, id };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < NOTE_ATTEMPTS) await Bun.sleep(noteRetryDelayMs * attempt);
    }
  }
  return { recorded: false, id: null, error: lastError };
}

export default command;
