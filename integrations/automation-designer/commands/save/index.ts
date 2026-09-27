import { readFile } from "fs/promises";
import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { buildGuardedV1SavePayload } from "../../lib/serialize/guard";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";

interface SaveArgs {
  filePath: string;
  uuid?: string;
  category?: string;
  isNew: boolean;
  yes: boolean;
}

interface SaveData {
  action: "CREATED" | "UPDATED";
  draftUuid: string;
  publishedUuid: string | null;
  version: number | string;
  switchedFromPublished: boolean;
  /** Overlay keys verified (pre-POST) to change the payload. */
  applied: string[];
}

export const args = defineArgs({
  command: "belz ad save",
  positionals: [{ name: "file", required: true, missingCode: "MISSING_FILE", missingMessage: "Missing <file> argument." }],
  flags: {
    ...AD_COMMON_FLAGS,
    ...AD_YES_FLAG,
    uuid: { type: "string" },
    category: { type: "string" },
    new: { type: "boolean" },
  },
  exclusive: [["uuid", "new"]],
});

const command: CommandModule<SaveArgs, SaveData> = {
  schema: "ad.save",
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "save", "save");
    return {
      filePath: positionals.file,
      uuid: flags.uuid,
      category: flags.category,
      isNew: flags.new,
      yes: flags.yes,
    };
  },
  async execute({ filePath, uuid, category, isNew, yes }, context) {
    let text: string;
    try {
      text = await readFile(filePath, "utf-8");
    } catch (err) {
      throw new CliError(`Cannot read overlay file ${filePath}: ${String(err)}`, { code: "FILE_NOT_FOUND" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new CliError(`Overlay file ${filePath} is not valid JSON: ${String(err)}`, { code: "INVALID_JSON" });
    }

    if (isNew) {
      if (!category) {
        throw new CliError("--category is required with --new.", {
          code: "MISSING_CATEGORY",
        });
      }
      throw new CliError(
        "Create-path saves are not wired yet — they need a category catalog lookup. " +
          "For now, save existing methods via --uuid <draftUuid>.",
        { code: "NOT_IMPLEMENTED" },
      );
    }

    if (!uuid) {
      throw new CliError("--uuid is required for updates (or pass --new for creation).", {
        code: "MISSING_UUID",
      });
    }

    // Draft-safety gate — mandatory for every write path.
    const guard = await resolveDraftTarget(uuid, "v1");
    if (!guard.ok) {
      throw new CliError(guard.message, {
        code: `AD_DRAFT_GUARD_${guard.reason}`,
        details: guard,
      });
    }
    const draft = guard.draft;

    // Apply the overlay and build the payload through the save guard: it
    // refuses unknown / unwritable / no-effect overlay keys and any drift in
    // fields the overlay did not target (lib/serialize/guard.ts).
    const { payload, applied } = buildGuardedV1SavePayload(draft, parsed, {
      version: typeof draft.version === "number" ? draft.version + 1 : undefined,
      warn: msg => context.warn(msg),
    });

    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `save draft ${draft.uuid}`,
      details: [
        ["Method", draft.name],
        ["Draft UUID", draft.uuid],
        ["Published UUID", guard.publishedUuid ?? "(none)"],
        ["Linked from PUBLISHED", guard.switchedFromPublished ? "Yes" : "No"],
        ["New version", String(payload.version ?? "")],
        ["Category", payload.category.name],
        ["Changes", applied.join(", ")],
      ],
    });

    logIntent("POST", "/rest/api/automation/chain", {
      draftUuid: draft.uuid,
      version: payload.version,
      bytes: payload.jsonDefinition.length,
    });

    const saved = await adApi.saveMethod(payload);

    return ok<SaveData>({
      action: "UPDATED",
      draftUuid: saved.method.uuid,
      publishedUuid: guard.publishedUuid,
      version: saved.method.version,
      switchedFromPublished: guard.switchedFromPublished,
      applied,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as SaveData;
    ui.success(`Saved ${data.action === "CREATED" ? "new draft" : "draft"}: ${data.draftUuid}`);
    ui.table(
      ["Property", "Value"],
      [
        ["Action", data.action],
        ["Draft UUID", data.draftUuid],
        ["Published UUID", data.publishedUuid ?? "(none)"],
        ["Version", data.version],
        ["Switched from PUBLISHED", data.switchedFromPublished ? "Yes" : "No"],
      ],
    );
  },
};

export default command;
