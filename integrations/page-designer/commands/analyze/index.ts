// belz pd analyze <id...> [--compliance <file>]
//
// Recursive dependency + AD-method analysis of one or more pages/components.
// PD-13 / F21: roots are given explicitly (the hardcoded nsm-dev root list is
// gone), every referenced component is followed (no components.json), and the
// compliance master list is an explicit file (no master_ids.txt from CWD).
// PD-19: fetch/resolve failures are reported in `errors`, never swallowed.

import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import {
  analyzeItem,
  collectAllAdIds,
  formatTreeLines,
  loadMasterIds,
  verifyCompliance,
  type AnalyzeError,
  type ComplianceResult,
  type ReportNode,
} from "../../lib/analyzer";
import { resolveInput } from "../../lib/resolver";

interface AnalyzeArgs {
  inputs: string[];
  complianceFile: string | null;
}

interface AnalyzeData {
  targetIds: string[];
  uniqueAdIds: string[];
  compliance: ComplianceResult | null;
  treeByRoot: Array<{ rootId: string; lines: string[] }>;
  errors: AnalyzeError[];
}

export const args = defineArgs({
  command: "belz pd analyze",
  positionals: [
    {
      name: "input",
      required: true,
      variadic: true,
      missingCode: "MISSING_INPUT",
      missingMessage: "Missing <input>. Pass one or more page/component ids, names or URLs.",
    },
  ],
  flags: {
    compliance: { type: "string" },
  },
});

const command: CommandModule<AnalyzeArgs, AnalyzeData> = {
  schema: "pd.analyze",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { inputs: positionals.input, complianceFile: flags.compliance ?? null };
  },
  async execute({ inputs, complianceFile }, context) {
    const masterIds = complianceFile ? await loadMasterIds(complianceFile) : null;

    const reports: ReportNode[] = [];
    const treeByRoot: Array<{ rootId: string; lines: string[] }> = [];
    const targetIds: string[] = [];
    const errors: AnalyzeError[] = [];
    for (const input of inputs) {
      const resolved = await resolveInput(input);
      targetIds.push(resolved.resolvedId);
      const report = await analyzeItem(resolved.resolvedId, resolved.response.name ?? input, new Set<string>(), errors);
      reports.push(report);
      treeByRoot.push({ rootId: resolved.resolvedId, lines: formatTreeLines(report) });
    }
    for (const e of errors) context.warn(`⚠ ${e.name}${e.id ? ` (${e.id})` : ""}: ${e.message}`);

    return ok({
      targetIds,
      uniqueAdIds: collectAllAdIds(reports),
      compliance: masterIds ? verifyCompliance(reports, masterIds) : null,
      treeByRoot,
      errors,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as AnalyzeData;

    data.treeByRoot.forEach(tree => {
      ui.section(`Visual Dependency Tree (${tree.rootId})`);
      tree.lines.forEach(line => ui.text(line));
    });

    ui.section("All Unique AD IDs");
    ui.text(data.uniqueAdIds.length > 0 ? data.uniqueAdIds.join(", ") : "None found.");
    ui.text(`Total Count: ${data.uniqueAdIds.length}`);

    if (data.compliance) {
      ui.section("Compliance Report");
      ui.table(
        ["Metric", "Count"],
        [
          ["Common IDs (Master ∩ Generated)", data.compliance.commonIds.length],
          ["Rogue IDs (Generated - Master)", data.compliance.rogueIds.length],
          ["Missing IDs (Master - Generated)", data.compliance.missingIds.length],
        ]
      );

      if (data.compliance.isCompliant) {
        ui.success("Compliance passed.");
      } else {
        ui.warn("Compliance failed.");
        if (data.compliance.rogueIds.length > 0) {
          ui.section("Rogue ID Sources");
          ui.table(
            ["ID", "Found In"],
            data.compliance.rogueIds.map(rogue => [rogue.id, rogue.foundIn.join(", ")])
          );
        }
      }

      if (data.compliance.missingIds.length > 0) {
        ui.section("IDs In Master But Missing From Pages");
        ui.text(data.compliance.missingIds.join(", "));
      }
    }
  },
};

export default command;
