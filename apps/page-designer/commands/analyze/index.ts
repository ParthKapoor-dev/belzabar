import { file } from "bun";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { TARGET_PAGE_IDS } from "../../lib/config";
import { analyzeItem } from "../../lib/analyzer";
import { collectAllAdIds, formatTreeLines } from "../../lib/reporter";
import { verifyCompliance } from "../../lib/comparator";
import type { ComplianceResult, ReportNode } from "../../lib/types";

interface AnalyzeArgs {
  pageIdArg?: string;
  runCompliance: boolean;
}

interface AnalyzeData {
  targetIds: string[];
  uniqueAdIds: string[];
  compliance: ComplianceResult | null;
  treeByRoot: Array<{ rootId: string; lines: string[] }>;
}

const command: CommandModule<AnalyzeArgs, AnalyzeData> = {
  schema: "pd.analyze",
  parseArgs(args) {
    return {
      pageIdArg: args[0] && !args[0].startsWith("-") ? args[0] : undefined,
      runCompliance: args.includes("--compliance"),
    };
  },
  async execute({ pageIdArg, runCompliance }, context) {
    const targetIds = pageIdArg ? [pageIdArg] : TARGET_PAGE_IDS;

    const componentsFile = file("components.json");
    if (!(await componentsFile.exists())) {
      throw new CliError("components.json not found in root directory.", {
        code: "COMPONENTS_FILE_MISSING",
      });
    }
    const list = await componentsFile.json();
    const componentsWhitelist = new Set(list);

    let masterIds = new Set<string>();
    if (runCompliance) {
      const masterFile = file("master_ids.txt");
      if (await masterFile.exists()) {
        const content = await masterFile.text();
        masterIds = new Set(
          content
            .split(",")
            .map(id => id.trim())
            .filter(id => id.length > 0)
        );
      } else {
        context.warn("master_ids.txt not found. Compliance check skipped.");
      }
    }

    const reports: ReportNode[] = [];
    const treeByRoot: Array<{ rootId: string; lines: string[] }> = [];
    for (const pageId of targetIds) {
      const visited = new Set<string>();
      const report = await analyzeItem(pageId, "PAGE", "Root Page", visited, componentsWhitelist);
      reports.push(report);
      treeByRoot.push({
        rootId: pageId,
        lines: formatTreeLines(report),
      });
    }

    const uniqueAdIds = collectAllAdIds(reports);
    const compliance =
      runCompliance && masterIds.size > 0 ? verifyCompliance(reports, masterIds) : null;

    return ok({
      targetIds,
      uniqueAdIds,
      compliance,
      treeByRoot,
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
