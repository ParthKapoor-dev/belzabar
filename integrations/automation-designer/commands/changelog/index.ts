import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi, type ChangelogEntry } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { resolveMethodRef } from "../../lib/ids";
import { AD_COMMON_FLAGS, AD_NOTE_FLAG, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import type { HydratedMethod } from "../../lib/types/common";
import { htmlToText, parseFieldList, projectRow } from "../../lib/compact";

interface ChangelogArgs {
  uuid: string;
  note?: string;
  yes: boolean;
  /** Raw `--fields` value (validated in parseArgs). */
  fields?: string;
}

interface ChangelogData {
  /** The uuid passed — only when it differs from chainUuid (--note on a published uuid). */
  uuid?: string;
  /** The chain whose notes are listed: the uuid passed for a listing, the resolved draft for --note. */
  chainUuid: string;
  chainId: number;
  action: "add" | "list";
  addedId?: string | null;
  addedNote?: string;
  total: number;
  entries: Array<Record<string, unknown>>;
}

// 7.9: compact entries (id, when = ISO time, author, note = the rich-text
// comment as plain text); `--fields a,b` picks (type, html = raw comment,
// user = full user object), `--fields all` = the server's entries unchanged.
export const ENTRY_FIELDS = ["id", "when", "author", "note", "type", "html", "user", "createdAt"] as const;
const DEFAULT_ENTRY_FIELDS = ["id", "when", "author", "note"];

export function entryRows(entries: ChangelogEntry[], fields: string | undefined): Array<Record<string, unknown>> {
  const sel = parseFieldList(fields, ENTRY_FIELDS);
  if (sel.mode === "all") return entries as unknown as Array<Record<string, unknown>>;
  return entries.map((e) =>
    projectRow(
      {
        id: e.id,
        when: e.createdAt ? new Date(e.createdAt).toISOString() : undefined,
        author: e.user?.fullName ?? e.user?.email,
        note: typeof e.comment === "string" ? htmlToText(e.comment) : undefined,
        type: e.changelogType,
        html: e.comment,
        user: e.user,
        createdAt: e.createdAt,
      },
      sel,
      DEFAULT_ENTRY_FIELDS,
    ),
  );
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
  flags: { ...AD_COMMON_FLAGS, ...AD_NOTE_FLAG, ...AD_YES_FLAG, fields: { type: "string" } },
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
    parseFieldList(flags.fields, ENTRY_FIELDS);
    return { uuid: positionals.uuid, note, yes: flags.yes, ...(flags.fields !== undefined ? { fields: flags.fields } : {}) };
  },
  async execute({ uuid: uuidArg, note, yes, fields }, context) {
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
        ...(uuid !== draft.uuid ? { uuid } : {}),
        chainUuid: draft.uuid,
        chainId,
        action: "add",
        addedId,
        addedNote: note,
        total: entries.length,
        entries: entryRows(entries, fields),
      });
    }

    const method = await adApi.fetchMethod(uuid, "v1");
    const chainId = chainIdOf(method);
    const entries = await adApi.listChangelog(chainId);
    return ok<ChangelogData>({
      ...(uuid !== method.uuid ? { uuid } : {}),
      chainUuid: method.uuid,
      chainId,
      action: "list",
      total: entries.length,
      entries: entryRows(entries, fields),
    });
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
    const columns: string[] = [];
    for (const r of data.entries) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
    const cell = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    ui.table(columns, data.entries.map((r) => columns.map((c) => cell(r[c]))));
  },
};

export default command;
