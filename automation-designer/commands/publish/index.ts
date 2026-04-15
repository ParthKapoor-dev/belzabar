import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";

interface PublishArgs {
  uuid: string;
  yes: boolean;
}

interface PublishData {
  draftUuid: string;
  publishedUuid: string;
  draftVersion: number | string;
  publishedVersion: number | string | null;
  inSync: boolean;
  switchedFromPublished: boolean;
}

const command: CommandModule<PublishArgs, PublishData> = {
  schema: "ad.publish",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "publish", "publish");
    emitFallbackWarning(common, "publish");
    const uuid = rest[0];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing <uuid> argument.", { code: "MISSING_UUID" });
    }
    return { uuid, yes: rest.includes("--yes") };
  },
  async execute({ uuid, yes }, context) {
    const guard = await resolveDraftTarget(uuid, "v1");
    if (!guard.ok) {
      throw new CliError(guard.message, {
        code: `AD_DRAFT_GUARD_${guard.reason}`,
        details: guard,
      });
    }
    const draft = guard.draft;

    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `publish draft ${draft.uuid} to production`,
      details: [
        ["Method", draft.name],
        ["Draft UUID", draft.uuid],
        ["Current published UUID", guard.publishedUuid ?? "(none — first publish)"],
        ["Draft version", String(draft.version)],
      ],
    });

    logIntent("POST", `/rest/api/automation/chain/${draft.uuid}/publish`, { draftUuid: draft.uuid });

    const { publishedUuid } = await adApi.publishDraft(draft.uuid);

    // Re-fetch both sides to compute sync state.
    const freshDraft = await adApi.fetchMethod(draft.uuid, "v1");
    let publishedVersion: number | string | null = null;
    try {
      const pub = await adApi.fetchMethod(publishedUuid, "v1");
      publishedVersion = pub.version;
    } catch {
      publishedVersion = null;
    }

    const inSync =
      typeof freshDraft.version === "number" &&
      typeof publishedVersion === "number" &&
      freshDraft.version === publishedVersion;

    return ok<PublishData>({
      draftUuid: freshDraft.uuid,
      publishedUuid,
      draftVersion: freshDraft.version,
      publishedVersion,
      inSync,
      switchedFromPublished: guard.switchedFromPublished,
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
        ["In sync", data.inSync ? "Yes" : "No"],
      ],
    );
  },
};

export default command;
