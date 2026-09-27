import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi, type ChangelogEntry } from "../../lib/api/index";
import { AD_COMMON_FLAGS, AD_NOTE_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent } from "../../lib/args/confirm";

interface ChangelogArgs {
  uuid: string;
  note?: string;
}

interface ChangelogData {
  uuid: string;
  chainId: number;
  action: "add" | "list";
  addedId?: string;
  addedNote?: string;
  entries: ChangelogEntry[];
}

async function resolveChainId(uuid: string): Promise<number> {
  const method = await adApi.fetchMethod(uuid, "v1");
  if (typeof method.numericId !== "number") {
    throw new CliError(`Could not resolve the numeric chain id for ${uuid}.`, {
      code: "AD_CHAIN_ID_UNAVAILABLE",
      details: { uuid },
    });
  }
  return method.numericId;
}

export const args = defineArgs({
  command: "belz ad changelog",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing <uuid> argument." }],
  flags: { ...AD_COMMON_FLAGS, ...AD_NOTE_FLAG },
});

const command: CommandModule<ChangelogArgs, ChangelogData> = {
  schema: "ad.changelog",
  writes: (a) => a.note !== undefined,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "list", "changelog") // changelog is V1-only: --v2 prints the fallback notice;
    return { uuid: positionals.uuid, note: flags.note?.trim() };
  },
  async execute({ uuid, note }, _context) {
    const chainId = await resolveChainId(uuid);

    if (note) {
      logIntent("POST", `/rest/api/automation/chain/changelog/${chainId}`, { chainId });
      const addedId = await adApi.addChangelog(chainId, note);
      const entries = await adApi.listChangelog(chainId);
      return ok<ChangelogData>({
        uuid,
        chainId,
        action: "add",
        addedId,
        addedNote: note,
        entries,
      });
    }

    const entries = await adApi.listChangelog(chainId);
    return ok<ChangelogData>({ uuid, chainId, action: "list", entries });
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
