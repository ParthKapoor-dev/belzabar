import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_YES_FLAG } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { CacheManager } from "../../lib/cache";
import { resolveMethodRef } from "@belzabar/core/platform";
import { deleteChainV2 } from "../../lib/save/api";
import { invalidateCompiledCache } from "../../lib/save/compiled-cache";
import * as v2 from "../../lib/api/v2";

interface DeleteArgs {
  uuid: string;
  yes: boolean;
}

interface DeleteData {
  uuid: string;
  name: string;
  deleted: true;
  /** The V2 re-read no longer finds the method (the platform only soft-deletes; V1 still returns it). */
  verified: boolean;
}

export const args = defineArgs({
  command: "belz ad delete",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing <uuid> argument." }],
  flags: { ...AD_YES_FLAG },
});

const command: CommandModule<DeleteArgs, DeleteData> = {
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { uuid: resolveMethodRef(positionals.uuid), yes: flags.yes };
  },
  async execute({ uuid, yes }, context) {
    // V2 read (no service lookups). A soft-deleted method no longer reads on
    // V2 (400 "automationAPI is null" → METHOD_NOT_FOUND); V1 still returns it,
    // and its `active`/`deprecatedAt` fields do not mark deletion (live:
    // every method has active:false, every save stamps deprecatedAt).
    const m = await adApi.fetchMethod(uuid, "v2");
    if (m.state !== "DRAFT") {
      throw new CliError(
        m.state === "PUBLISHED"
          ? `Method ${uuid} is PUBLISHED; belz never deletes published methods.`
          : `Method ${uuid} has no recognisable draft/published state; refusing to delete (fail closed).`,
        { code: m.state === "PUBLISHED" ? "AD_DELETE_PUBLISHED" : "AD_DRAFT_GUARD_STATE_UNKNOWN", details: { uuid, state: m.state } },
      );
    }
    if (m.referenceId) {
      throw new CliError(
        `Draft ${uuid} has a published version (${m.referenceId}); deleting the draft would orphan it. Refusing.`,
        { code: "AD_DELETE_HAS_PUBLISHED", details: { uuid, publishedUuid: m.referenceId } },
      );
    }

    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `delete draft ${uuid}`,
      details: [
        ["Method", m.name],
        ["UUID", uuid],
        ["Category", m.category?.name ?? "?"],
        ["State", `${m.state}, never published`],
      ],
    });

    logIntent("DELETE", `/rest/api/automation/chain/v2/${uuid}`, { uuid });
    await deleteChainV2(uuid);
    await CacheManager.invalidate(uuid);
    await invalidateCompiledCache([uuid]);

    let verified = false;
    try {
      await v2.fetchRawMethod(uuid);
    } catch (err) {
      verified = err instanceof CliError && err.code === "METHOD_NOT_FOUND";
    }
    if (!verified) context.warn(`DELETE answered OK, but ${uuid} still reads back on V2; check it in the AD UI.`);
    return ok<DeleteData>({ uuid, name: m.name, deleted: true, verified });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as DeleteData;
    ui.success(`Deleted draft ${d.name} (${d.uuid})${d.verified ? "" : " — not verified"}`);
  },
};

export default command;
