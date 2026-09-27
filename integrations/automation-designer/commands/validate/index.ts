// belz ad validate <uuid|file> — read-only run of the pre-save validator
// (lib/validate) over a method's V2 body: a saved method (fetched by uuid) or a
// local V2 JSON file (the body you are about to save).
//
// L1–L3 offline; --online adds the L4 service lookup; --dry-run-compile adds the
// gated server compile (implies --online; POSTs /chain/test with every step
// switched off, so it needs an explicit --env like other test endpoints).
// Errors → AD_VALIDATION_FAILED (ok:false, exit 1) with the full result as data.

import { readFile } from "fs/promises";
import { CliError, defineArgs, failWithData, ok, type CommandModule } from "@belzabar/core";
import * as v2 from "../../lib/api/v2";
import { resolveMethodRef } from "../../lib/ids";
import { validateMethodV2, validateOnline, type ValidationFinding } from "../../lib/validate/index";
import type { V2MethodBody } from "../../lib/types/v2-wire";

interface ValidateArgs {
  target: string;
  kind: "uuid" | "file";
  online: boolean;
  dryRunCompile: boolean;
  strict: boolean;
}

export interface ValidateData {
  source: { kind: "uuid" | "file"; ref: string };
  uuid: string | null;
  name: string | null;
  state: string | null;
  valid: boolean;
  counts: { errors: number; warnings: number };
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  layersRun: string[];
  notes: string[];
}

export const args = defineArgs({
  command: "belz ad validate",
  positionals: [{ name: "target", required: true, missingCode: "MISSING_TARGET", missingMessage: "Missing <uuid|file> argument." }],
  flags: {
    online: { type: "boolean", description: "Also check each step against its service contract on --env (L4)" },
    "dry-run-compile": { type: "boolean", description: "Also compile the method on the server with every step switched off (implies --online)" },
    strict: { type: "boolean", description: "Treat warnings as errors" },
  },
});

function looksLikeFile(target: string): boolean {
  return target.endsWith(".json") || target.includes("/") || target.startsWith(".");
}

const command: CommandModule<ValidateArgs, ValidateData> = {
  schema: "ad.validate",
  writes: (a) => a.dryRunCompile,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    const target = positionals.target;
    const kind = looksLikeFile(target) ? "file" : "uuid";
    return {
      target: kind === "uuid" ? resolveMethodRef(target) : target,
      kind,
      online: flags.online || flags.dryRunCompile,
      dryRunCompile: flags.dryRunCompile,
      strict: flags.strict,
    };
  },
  async execute(a, context) {
    const body = a.kind === "file" ? await readBody(a.target) : await v2.fetchRawMethod(a.target);
    const notes: string[] = [];
    const input = { after: body, strict: a.strict };
    const result = a.online
      ? await validateOnline({ ...input, env: context.env.name, dryRunCompile: a.dryRunCompile })
      : validateMethodV2(input);

    const state = typeof body.metadata?.state === "string" ? body.metadata.state : null;
    let errors = result.errors;
    if (a.kind === "uuid" && state === "PUBLISHED") {
      // Auditing a published record: "a save body must be a draft" is not a finding about the logic.
      errors = errors.filter((e) => e.rule !== "AD-META-001");
      notes.push("PUBLISHED record: AD-META-001 (save bodies must be drafts) is not reported; validate the draft before saving.");
    }
    const data: ValidateData = {
      source: { kind: a.kind, ref: a.target },
      uuid: typeof body.uuid === "string" ? body.uuid.trim() : null,
      name: typeof body.name === "string" ? body.name : null,
      state,
      valid: errors.length === 0,
      counts: { errors: errors.length, warnings: result.warnings.length },
      errors,
      warnings: result.warnings,
      layersRun: result.layersRun,
      notes,
    };
    if (errors.length > 0) {
      return failWithData("AD_VALIDATION_FAILED", `${errors.length} error(s), ${result.warnings.length} warning(s) in ${data.name ?? a.target}.`, data, {
        details: { errors, warnings: result.warnings, layersRun: result.layersRun },
      });
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    const d = envelope.data as ValidateData | null;
    if (!d) return;
    ui.section(`Validate ${d.name ?? d.source.ref}${d.state ? ` (${d.state})` : ""}`);
    const line = (f: ValidationFinding) => {
      const where = f.step ? `step ${f.step.orderIndex} (${f.step.kind}${f.step.service ? ` ${f.step.service}` : ""})  ` : "";
      return `${f.rule}${f.preexisting ? " (pre-existing)" : ""}  ${where}${f.path}\n    ${f.message}${f.fix ? `\n    fix: ${f.fix}` : ""}`;
    };
    for (const f of d.errors) ui.error(line(f));
    for (const f of d.warnings) ui.warn(line(f));
    for (const n of d.notes) ui.info(n);
    const summary = `${d.counts.errors} error(s), ${d.counts.warnings} warning(s) — layers ${d.layersRun.join(", ")}`;
    if (d.valid) ui.success(summary);
    else ui.text(summary);
  },
};

async function readBody(path: string): Promise<V2MethodBody> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new CliError(`Cannot read ${path}: ${String(err)}`, { code: "FILE_NOT_FOUND" });
  }
  try {
    return JSON.parse(text) as V2MethodBody;
  } catch (err) {
    throw new CliError(`${path} is not valid JSON: ${String(err)}`, { code: "INVALID_JSON" });
  }
}

export default command;
