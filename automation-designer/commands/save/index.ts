import { readFile } from "fs/promises";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import { serializeToV1SavePayload } from "../../lib/serialize/v1";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import type { HydratedMethod, CustomCodeStep } from "../../lib/types/common";
import type { V1InnerDefinition, V1SavePayload } from "../../lib/types/v1-wire";

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
}

const command: CommandModule<SaveArgs, SaveData> = {
  schema: "ad.save",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "save", "save");
    emitFallbackWarning(common, "save");

    const filePath = rest[0];
    if (!filePath || filePath.startsWith("-")) {
      throw new CliError("Missing <file> argument.", { code: "MISSING_FILE" });
    }

    const uuidIdx = rest.indexOf("--uuid");
    const catIdx = rest.indexOf("--category");
    return {
      filePath,
      uuid: uuidIdx !== -1 ? rest[uuidIdx + 1] : undefined,
      category: catIdx !== -1 ? rest[catIdx + 1] : undefined,
      isNew: rest.includes("--new"),
      yes: rest.includes("--yes"),
    };
  },
  async execute({ filePath, uuid, category, isNew, yes }, context) {
    const text = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(text) as Record<string, unknown>;

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

    // Apply the file's changes to the in-memory HydratedMethod. The file is
    // allowed to carry a partial overlay: { inputs?, outputs?, variables?,
    // parsedSteps? } or a full replacement jsonDefinition. We keep this tiny
    // and explicit for v1.
    applyOverlay(draft, parsed);

    // Build the save payload via the serializer (which enforces the custom-
    // code multi-output invariant).
    const payload: V1SavePayload = serializeToV1SavePayload(draft, {
      version: typeof draft.version === "number" ? draft.version + 1 : undefined,
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

/**
 * Apply the user's JSON overlay onto a HydratedMethod in place. Supported
 * keys (all optional):
 *   - name, summary, description, buttonLabel, internalMethod
 *   - inputs[].testValue (mapped onto existing inputs by code)
 *   - parsedSteps[] — if present, must be an array of {orderIndex, source?}
 *     entries; we patch CUSTOM_CODE source on the matching steps.
 *
 * Anything else is ignored with a warning. This keeps the save path small
 * and predictable while still supporting the most common agent use case:
 * "I edited the JS in step 2; save it."
 */
function applyOverlay(method: HydratedMethod, overlay: Record<string, unknown>): void {
  if (typeof overlay.name === "string") method.name = overlay.name;
  if (typeof overlay.summary === "string") method.summary = overlay.summary;
  if (typeof overlay.description === "string") method.description = overlay.description;
  if (typeof overlay.buttonLabel === "string") method.buttonLabel = overlay.buttonLabel;
  if (typeof overlay.internalMethod === "boolean") method.internalMethod = overlay.internalMethod;

  if (Array.isArray(overlay.inputs)) {
    const byCode = new Map(method.inputs.map(i => [i.code, i]));
    for (const o of overlay.inputs) {
      if (!o || typeof o !== "object") continue;
      const code = (o as Record<string, unknown>).code;
      if (typeof code !== "string") continue;
      const target = byCode.get(code);
      if (!target) continue;
      if ((o as Record<string, unknown>).testValue !== undefined) {
        target.testValue = (o as Record<string, unknown>).testValue;
      }
    }
  }

  if (Array.isArray(overlay.parsedSteps)) {
    const byIndex = new Map(method.parsedSteps.map(s => [s.orderIndex, s]));
    for (const o of overlay.parsedSteps) {
      if (!o || typeof o !== "object") continue;
      const idx = (o as Record<string, unknown>).orderIndex;
      if (typeof idx !== "number") continue;
      const target = byIndex.get(idx);
      if (!target) continue;
      const src = (o as Record<string, unknown>).source;
      if (typeof src === "string" && target.kind === "CUSTOM_CODE") {
        (target as CustomCodeStep).source = src;
      }
      const desc = (o as Record<string, unknown>).description;
      if (typeof desc === "string") target.description = desc;
    }
  }
}

export default command;
