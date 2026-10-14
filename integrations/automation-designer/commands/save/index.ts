import { readFile } from "fs/promises";
import { dirname } from "path";
import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { resolveMethodRef } from "@belzabar/core/platform";
import { AD_YES_FLAG } from "../../lib/args/common";
import { requireConfirmation } from "../../lib/args/confirm";
import { saveOverlayV2, type SaveDryRunData, type SaveV2Data } from "../../lib/save/pipeline";
import { VALIDATION_FLAGS } from "../../lib/save/flags";
import { addFileFlagOps, resolveOverlaySources } from "../../lib/save/sources";

interface SaveArgs {
  filePath: string | null;
  uuid: string;
  sqlFiles: string[];
  codeFiles: string[];
  dryRun: boolean;
  yes: boolean;
  noValidate: boolean;
  strict: boolean;
  dryRunCompile: boolean;
}

export const args = defineArgs({
  command: "wi-impl ad save",
  positionals: [{ name: "file" }],
  flags: {
    ...AD_YES_FLAG,
    ...VALIDATION_FLAGS,
    uuid: {
      type: "string",
      required: true,
      missingCode: "MISSING_UUID",
      missingMessage: "--uuid <draftUuid> is required (to create a method use `wi-impl ad create`).",
    },
    "sql-file": { type: "string", repeatable: true, description: "N=path: replace step N's SQL with the file" },
    "code-file": { type: "string", repeatable: true, description: "N=path: replace step N's custom code with the file" },
    "dry-run": { type: "boolean", description: "Plan and validate only; nothing is written" },
  },
});

const command: CommandModule<SaveArgs, SaveV2Data | SaveDryRunData> = {
  // --dry-run-compile POSTs the executing /chain/test route (steps gated
  // off), so even a dry run with it must name --env explicitly.
  writes: (a) => !a.dryRun || a.dryRunCompile,
  requiresEnv: true, // --dry-run reads the target draft: never the default env silently
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    const filePath = positionals.file ?? null;
    if (!filePath && flags.sqlFile.length === 0 && flags.codeFile.length === 0) {
      throw new CliError("Missing <file> argument (or --sql-file / --code-file).", { code: "MISSING_FILE" });
    }
    return {
      filePath,
      uuid: flags.uuid,
      sqlFiles: flags.sqlFile,
      codeFiles: flags.codeFile,
      dryRun: flags.dryRun,
      yes: flags.yes,
      noValidate: flags.noValidate,
      strict: flags.strict,
      dryRunCompile: flags.dryRunCompile,
    };
  },
  async execute(a, context) {
    let overlay: unknown = {};
    if (a.filePath) {
      let text: string;
      try {
        text = await readFile(a.filePath, "utf-8");
      } catch (err) {
        throw new CliError(`Cannot read overlay file ${a.filePath}: ${String(err)}`, { code: "FILE_NOT_FOUND" });
      }
      try {
        overlay = JSON.parse(text);
      } catch (err) {
        throw new CliError(`Overlay file ${a.filePath} is not valid JSON: ${String(err)}`, { code: "INVALID_JSON" });
      }
      await resolveOverlaySources(overlay, dirname(a.filePath));
    }
    if (a.sqlFiles.length || a.codeFiles.length) {
      if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
        throw new CliError("Overlay must be a JSON object.", { code: "AD_OVERLAY_INVALID" });
      }
      await addFileFlagOps(overlay as Record<string, unknown>, { sqlFiles: a.sqlFiles, codeFiles: a.codeFiles }, process.cwd());
    }

    const data = await saveOverlayV2({
      dryRun: a.dryRun,
      uuid: resolveMethodRef(a.uuid),
      overlay,
      env: context.env.name,
      flags: { noValidate: a.noValidate, strict: a.strict, dryRunCompile: a.dryRunCompile },
      warn: (msg) => context.warn(msg),
      confirm: (action, details) => requireConfirmation({ yes: a.yes, outputMode: context.outputMode, action, details }),
    });
    return ok<SaveV2Data | SaveDryRunData>(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    if ((envelope.data as SaveDryRunData).action === "DRY_RUN") {
      const d = envelope.data as SaveDryRunData;
      const head = `Dry run: draft ${d.draftUuid} v${d.version ?? "?"}: ${d.valid ? "valid" : `${d.validation.errors.length} blocking finding(s)`} (nothing written)`;
      if (d.valid) ui.success(head);
      else ui.warn(head);
      for (const f of d.validation.errors) ui.warn(`${f.rule} ${f.path}: ${f.message}`);
      ui.table(
        ["Property", "Value"],
        [
          ["Applied", d.applied.join("; ")],
          ["Unchanged", d.unchanged.join(", ") || "-"],
          ...(d.order ? [["Step order", d.order.map((f) => (f === null ? "new" : String(f))).join(" ")] as [string, string]] : []),
          ["Validation", d.validation.skipped ? "SKIPPED" : `${d.validation.warnings.length} warning(s)`],
        ],
      );
      return;
    }
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
