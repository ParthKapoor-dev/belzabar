// belz pd analyze <id...> [--compliance <file>]
//
// Recursive dependency + AD-method analysis of one or more pages/components.
// PD-13 / F21: roots are given explicitly (the old hard-coded, tenant-specific root list is
// gone), every referenced component is followed (no components.json), and the
// compliance master list is an explicit file (no master_ids.txt from CWD).
// PD-19: fetch/resolve failures are reported in `errors`, never swallowed.
// OTH-R15: with --compliance, rogue ids → ok:false PD_COMPLIANCE_FAILED; an
// incomplete walk → isCompliant:null, ok:false PD_COMPLIANCE_INCOMPLETE.

import { defineArgs, failWithData, ok, type CommandModule } from "@belzabar/core";
import {
  analyzeItem,
  cacheDeps,
  cacheUseWarning,
  collectAllAdIds,
  emptySourceCounts,
  formatTreeLines,
  loadMasterIds,
  verifyCompliance,
  type AnalyzeError,
  type ComplianceResult,
  type ReportNode,
  type SourceCounts,
} from "../../lib/analyzer";
import { PD_FORCE_FLAG } from "../../lib/args/common";
import { resolveInput } from "../../lib/resolver";

interface AnalyzeArgs {
  inputs: string[];
  complianceFile: string | null;
  force: boolean;
}

interface AnalyzeData {
  targetIds: string[];
  uniqueAdIds: string[];
  compliance: ComplianceResult | null;
  treeByRoot: Array<{ rootId: string; lines: string[] }>;
  errors: AnalyzeError[];
  /** Where the configs came from (OTH-R13: cached data is up to 1 h old). */
  cache: SourceCounts;
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
    ...PD_FORCE_FLAG,
  },
});

const command: CommandModule<AnalyzeArgs, AnalyzeData> = {
  schema: "pd.analyze",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { inputs: positionals.input, complianceFile: flags.compliance ?? null, force: flags.force };
  },
  async execute({ inputs, complianceFile, force }, context) {
    const masterIds = complianceFile ? await loadMasterIds(complianceFile) : null;

    const reports: ReportNode[] = [];
    const treeByRoot: Array<{ rootId: string; lines: string[] }> = [];
    const targetIds: string[] = [];
    const errors: AnalyzeError[] = [];
    const cache = emptySourceCounts();
    const deps = cacheDeps(force, cache);
    for (const input of inputs) {
      const resolved = await resolveInput(input, force);
      cache[resolved.source]++;
      targetIds.push(resolved.resolvedId);
      const report = await analyzeItem(resolved.resolvedId, resolved.response.name ?? input, new Set<string>(), errors, deps, resolved.response);
      reports.push(report);
      treeByRoot.push({ rootId: resolved.resolvedId, lines: formatTreeLines(report) });
    }
    for (const e of errors) context.warn(`⚠ ${e.name}${e.id ? ` (${e.id})` : ""}: ${e.message}`);
    const note = cacheUseWarning(cache);
    if (note) context.warn(note);

    const data: AnalyzeData = {
      targetIds,
      uniqueAdIds: collectAllAdIds(reports),
      compliance: masterIds ? verifyCompliance(reports, masterIds, errors.length) : null,
      treeByRoot,
      errors,
      cache,
    };
    // OTH-R15: a compliance check is a gate — a failure or an incomplete walk is ok:false (exit 1).
    if (data.compliance?.isCompliant === false) {
      return failWithData(
        "PD_COMPLIANCE_FAILED",
        `${data.compliance.rogueIds.length} AD id(s) are not in the master list.`,
        data,
      );
    }
    if (data.compliance && data.compliance.isCompliant === null) {
      return failWithData(
        "PD_COMPLIANCE_INCOMPLETE",
        `Compliance not proven: ${errors.length} component(s) could not be inspected (see data.errors).`,
        data,
      );
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.data) return;
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

      if (data.compliance.isCompliant === true) {
        ui.success("Compliance passed.");
      } else if (data.compliance.isCompliant === null) {
        ui.warn("Compliance NOT proven: part of the tree could not be inspected (see errors).");
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
