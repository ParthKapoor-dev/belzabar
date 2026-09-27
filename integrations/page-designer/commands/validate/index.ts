// belz pd validate <input> — run every validator rule over a page/component.
//
// PD-8 / F18: when any rule reports an ERROR the envelope is ok:false
// (PD_VALIDATION_FAILED, exit 1) with the full report in `data`. Rule
// severities are calibrated against real editor output (PD-5).

import { defineArgs, failWithData, ok, type CommandModule } from "@belzabar/core";
import { PD_FORCE_FLAG, PD_INPUT_POSITIONAL } from "../../lib/args/common";
import { parsePage } from "../../lib/parser/index";
import { resolveInput } from "../../lib/resolver";
import { partitionBySeverity, validateHydrated } from "../../lib/validator/index";
import type { ValidationIssue } from "../../lib/types/common";

interface ValidateArgs {
  input: string;
  force: boolean;
}

interface ValidateData {
  name: string;
  id: string;
  entityType: "PAGE" | "COMPONENT";
  issues: ValidationIssue[];
  errorCount: number;
  warnCount: number;
}

export const args = defineArgs({
  command: "belz pd validate",
  positionals: [PD_INPUT_POSITIONAL],
  flags: { ...PD_FORCE_FLAG },
});

const command: CommandModule<ValidateArgs, ValidateData> = {
  schema: "pd.validate",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { input: positionals.input, force: flags.force };
  },
  async execute({ input, force }) {
    const resolved = await resolveInput(input, force);
    const page = parsePage(resolved.response);
    const issues = validateHydrated(page);
    const { errors, warnings } = partitionBySeverity(issues);

    const data: ValidateData = {
      name: page.name || resolved.resolvedId,
      id: resolved.resolvedId,
      entityType: resolved.entityType,
      issues,
      errorCount: errors.length,
      warnCount: warnings.length,
    };
    if (errors.length > 0) {
      return failWithData("PD_VALIDATION_FAILED", `${errors.length} validator error(s) on ${data.name}.`, data);
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    const data = envelope.data as ValidateData | undefined;
    if (!data) return;

    ui.kv("Name", data.name);
    ui.kv("Entity Type", data.entityType);

    if (data.issues.length === 0) {
      ui.success("No issues found.");
      return;
    }

    ui.section("Issues");
    ui.table(
      ["#", "Sev", "Code", "Message"],
      data.issues.map((issue, idx) => [idx + 1, issue.severity.toUpperCase(), issue.code, issue.message]),
    );

    ui.section("Summary");
    ui.kv("Errors", data.errorCount);
    ui.kv("Warnings", data.warnCount);
    ui.kv("Total", data.issues.length);
  },
};

export default command;
