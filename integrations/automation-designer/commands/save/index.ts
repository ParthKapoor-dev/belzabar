import { readFile } from "fs/promises";
import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { resolveMethodRef } from "../../lib/ids";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { requireConfirmation } from "../../lib/args/confirm";
import { saveOverlayV2, type SaveV2Data } from "../../lib/save/pipeline";
import { VALIDATION_FLAGS } from "../../lib/save/flags";

interface SaveArgs {
  filePath: string;
  uuid: string;
  yes: boolean;
  noValidate: boolean;
  strict: boolean;
  dryRunCompile: boolean;
}

export const args = defineArgs({
  command: "belz ad save",
  positionals: [{ name: "file", required: true, missingCode: "MISSING_FILE", missingMessage: "Missing <file> argument." }],
  flags: {
    ...AD_COMMON_FLAGS,
    ...AD_YES_FLAG,
    ...VALIDATION_FLAGS,
    uuid: {
      type: "string",
      required: true,
      missingCode: "MISSING_UUID",
      missingMessage: "--uuid <draftUuid> is required (to create a method use `belz ad create`).",
    },
  },
});

const command: CommandModule<SaveArgs, SaveV2Data> = {
  schema: "ad.save",
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "save", "save");
    return {
      filePath: positionals.file,
      uuid: flags.uuid,
      yes: flags.yes,
      noValidate: flags.noValidate,
      strict: flags.strict,
      dryRunCompile: flags.dryRunCompile,
    };
  },
  async execute(a, context) {
    let text: string;
    try {
      text = await readFile(a.filePath, "utf-8");
    } catch (err) {
      throw new CliError(`Cannot read overlay file ${a.filePath}: ${String(err)}`, { code: "FILE_NOT_FOUND" });
    }
    let overlay: unknown;
    try {
      overlay = JSON.parse(text);
    } catch (err) {
      throw new CliError(`Overlay file ${a.filePath} is not valid JSON: ${String(err)}`, { code: "INVALID_JSON" });
    }

    const data = await saveOverlayV2({
      uuid: resolveMethodRef(a.uuid),
      overlay,
      env: context.env.name,
      flags: { noValidate: a.noValidate, strict: a.strict, dryRunCompile: a.dryRunCompile },
      warn: (msg) => context.warn(msg),
      confirm: (action, details) => requireConfirmation({ yes: a.yes, outputMode: context.outputMode, action, details }),
    });
    return ok<SaveV2Data>(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as SaveV2Data;
    ui.success(`Saved draft ${data.draftUuid} (v${data.previousVersion ?? "?"} → v${data.version ?? "?"}), verified on re-read`);
    ui.table(
      ["Property", "Value"],
      [
        ["Draft UUID", data.draftUuid],
        ["Published UUID", data.publishedUuid ?? "(none)"],
        ["Version", `${data.previousVersion ?? "?"} → ${data.version ?? "?"}`],
        ["Switched from PUBLISHED", data.switchedFromPublished ? "Yes" : "No"],
        ["Applied", data.applied.join(", ")],
        ["Unchanged", data.unchanged.join(", ") || "-"],
        ["Validation", data.validation.skipped ? "SKIPPED" : `${data.validation.warnings.length} warning(s)`],
        ["Compiled cache", data.compiledCache.ok ? "evicted" : "NOT evicted"],
      ],
    );
  },
};

export default command;
