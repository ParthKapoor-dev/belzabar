import { CliError, ok, type CommandModule } from "@belzabar/core";
import { validateConfig } from "../../lib/parser";
import { resolveInput } from "../../lib/resolver";
import type { ValidationIssue } from "../../lib/types";

interface ValidateArgs {
  input: string;
}

interface ValidateData {
  name: string;
  entityType: "PAGE" | "COMPONENT";
  issues: ValidationIssue[];
  errorCount: number;
  warnCount: number;
}

const command: CommandModule<ValidateArgs, ValidateData> = {
  schema: "pd.validate",
  parseArgs(args) {
    const input = args[0];
    if (!input || input.startsWith("-")) {
      throw new CliError(
        "Missing argument. Provide a page URL, PD designer URL, page/component ID, or component name.",
        { code: "MISSING_INPUT" }
      );
    }
    return { input };
  },
  async execute({ input }) {
    const resolved = await resolveInput(input);
    const issues = validateConfig(resolved.response.configuration);

    const errorCount = issues.filter(i => i.severity === "error").length;
    const warnCount = issues.filter(i => i.severity === "warn").length;

    return ok({
      name: resolved.response.name || resolved.resolvedId,
      entityType: resolved.entityType,
      issues,
      errorCount,
      warnCount,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ValidateData;

    ui.kv("Name", data.name);
    ui.kv("Entity Type", data.entityType);

    if (data.issues.length === 0) {
      ui.success("No issues found.");
      return;
    }

    ui.section("Issues");
    ui.table(
      ["#", "Sev", "Code", "Message"],
      data.issues.map((issue, idx) => [
        idx + 1,
        issue.severity.toUpperCase(),
        issue.code,
        issue.message,
      ])
    );

    ui.section("Summary");
    ui.kv("Errors", data.errorCount);
    ui.kv("Warnings", data.warnCount);
    ui.kv("Total", data.issues.length);
  },
};

export default command;
