// belz ad validate <uuid|file> — read-only run of the pre-save validator
// (lib/validate) over a method's V2 body: a saved method (fetched by uuid) or a
// local V2 JSON file (the body you are about to save).
//
// L1–L3 offline; --online adds the L4 service lookup; --dry-run-compile adds the
// gated server compile (implies --online; POSTs /chain/test with every step
// switched off, so it needs an explicit --env like other test endpoints).
// Errors → AD_VALIDATION_FAILED (ok:false, exit 1) with the full result as data.

import { defineArgs, failWithData, ok, type CommandModule } from "@belzabar/core";
import { auditExistingRecord, validateMethodV2, validateOnline, type ValidationFinding } from "../../lib/validate/index";
import { loadTargetBody, methodTarget, type LoadedBody } from "../../lib/save/spec";

interface ValidateArgs {
  target: string;
  kind: "uuid" | "file";
  category: string | null;
  online: boolean;
  dryRunCompile: boolean;
  strict: boolean;
}

export interface ValidateData {
  source: { kind: "uuid" | "file"; ref: string };
  /** The file was a compact create spec, expanded first (as `ad create --dry-run`). */
  spec?: LoadedBody<unknown>["spec"];
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
    category: { type: "string", description: "Category for a compact spec file without spec.category" },
  },
});


const command: CommandModule<ValidateArgs, ValidateData> = {
  writes: (a) => a.dryRunCompile,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return {
      ...methodTarget(positionals.target),
      category: flags.category ?? null,
      online: flags.online || flags.dryRunCompile,
      dryRunCompile: flags.dryRunCompile,
      strict: flags.strict,
    };
  },
  async execute(a, context) {
    const loaded = await loadTargetBody(a, a.category);
    const body = loaded.body;
    const notes: string[] = [];
    const input = { after: body, strict: a.strict };
    const result = a.online
      ? await validateOnline({ ...input, env: context.env.name, dryRunCompile: a.dryRunCompile })
      : validateMethodV2(input);

    const state = typeof body.metadata?.state === "string" ? body.metadata.state : null;
    let errors = result.errors;
    let warnings = result.warnings;
    if (a.kind === "uuid") {
      // Auditing an existing record (ADW-R15): how it is stored (a PUBLISHED
      // record, a legacy name) is not a finding about its logic.
      const audit = auditExistingRecord(result, body);
      errors = audit.errors;
      warnings = audit.warnings;
      notes.push(...audit.notes);
    }
    const data: ValidateData = {
      source: { kind: a.kind, ref: a.target },
      ...(loaded.spec ? { spec: loaded.spec } : {}),
      uuid: typeof body.uuid === "string" ? body.uuid.trim() : null,
      name: typeof body.name === "string" ? body.name : null,
      state,
      valid: errors.length === 0,
      counts: { errors: errors.length, warnings: warnings.length },
      errors,
      warnings,
      layersRun: result.layersRun,
      notes,
    };
    if (errors.length > 0) {
      return failWithData("AD_VALIDATION_FAILED", `${errors.length} error(s), ${warnings.length} warning(s) in ${data.name ?? a.target}.`, data, {
        details: { errors, warnings, layersRun: result.layersRun },
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


export default command;
