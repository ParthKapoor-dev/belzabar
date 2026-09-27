import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi, type ChangelogEntry } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { resolveMethodRef } from "../../lib/ids";
import { AD_COMMON_FLAGS, AD_NOTE_FLAG, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import type { HydratedMethod } from "../../lib/types/common";

interface ChangelogArgs {
  uuid: string;
  note?: string;
  yes: boolean;
}

interface ChangelogData {
  uuid: string;
  /** The chain whose notes are listed: the uuid passed for a listing, the resolved draft for --note. */
  chainUuid: string;
  chainId: number;
  action: "add" | "list";
  addedId?: string | null;
  addedNote?: string;
  entries: ChangelogEntry[];
}

function chainIdOf(method: HydratedMethod): number {
  if (typeof method.numericId !== "number") {
    throw new CliError(`Could not resolve the numeric chain id for ${method.uuid}.`, {
      code: "AD_CHAIN_ID_UNAVAILABLE",
      details: { uuid: method.uuid },
    });
  }
  return method.numericId;
}

export const args = defineArgs({
  command: "belz ad changelog",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing <uuid> argument." }],
  flags: { ...AD_COMMON_FLAGS, ...AD_NOTE_FLAG, ...AD_YES_FLAG },
});

const command: CommandModule<ChangelogArgs, ChangelogData> = {
  schema: "ad.changelog",
  writes: (a) => a.note !== undefined,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "list", "changelog") // changelog is V1-only: --v2 prints the fallback notice;
    const note = flags.note?.trim();
    if (flags.note !== undefined && !note) {
      throw new CliError('--note needs a non-empty text.', { code: "MISSING_CHANGE_NOTE" });
    }
    return { uuid: positionals.uuid, note, yes: flags.yes };
  },
  async execute({ uuid: uuidArg, note, yes }, context) {
    const uuid = resolveMethodRef(uuidArg);
    if (note) {
      // AD-33: a note is recorded on the DRAFT chain (as `publish` does; the
      // server mirrors draft notes to the published chain on publish), so the
      // result no longer depends on which uuid of the pair was passed.
      const guard = await resolveDraftTarget(uuid, "v1");
      if (!guard.ok) {
        throw new CliError(guard.message, { code: `AD_DRAFT_GUARD_${guard.reason}`, details: { uuid } });
      }
      const draft = guard.draft;
      const chainId = chainIdOf(draft);
      // AD-32: a note is a write — confirm (or --yes; mandatory in --llm).
      await requireConfirmation({
        yes,
        outputMode: context.outputMode,
        action: `record a change note on ${draft.name}`,
        details: [
          ["Method", draft.name],
          ["Draft UUID", draft.uuid],
          ["Chain id", String(chainId)],
          ["Note", note],
        ],
      });
      logIntent("POST", `/rest/api/automation/chain/changelog/${chainId}`, { chainId, uuid: draft.uuid });
      const addedId = await adApi.addChangelog(chainId, note);
      const entries = await adApi.listChangelog(chainId);
      return ok<ChangelogData>({
        uuid,
        chainUuid: draft.uuid,
        chainId,
        action: "add",
        addedId,
        addedNote: note,
        entries,
      });
    }

    const method = await adApi.fetchMethod(uuid, "v1");
    const chainId = chainIdOf(method);
    const entries = await adApi.listChangelog(chainId);
    return ok<ChangelogData>({ uuid, chainUuid: method.uuid, chainId, action: "list", entries });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ChangelogData;
    if (data.action === "add") {
      ui.success(`Recorded change note on chain ${data.chainId}`);
    }
    if (data.entries.length === 0) {
      ui.info(`No change notes on chain ${data.chainId}.`);
      return;
    }
    ui.table(
      ["When", "Author", "Note"],
      data.entries.map((e) => [
        e.createdAt ? new Date(e.createdAt).toISOString() : "(unknown)",
        e.user?.fullName ?? e.user?.email ?? "(unknown)",
        e.comment ?? "",
      ]),
    );
  },
};

export default command;
