import { file } from "bun";
import { TARGET_PAGE_IDS } from "../../lib/config";
import { analyzeItem } from "../../lib/analyzer";
import { printTree, collectAllAdIds } from "../../lib/reporter";
import { verifyCompliance } from "../../lib/comparator";
import type { ReportNode } from "../../lib/types";
import { DisplayManager } from "@belzabar/core";

export async function run(args: string[]) {
  const pageIdArg = args[0];
  const targetIds = pageIdArg ? [pageIdArg] : TARGET_PAGE_IDS;

  DisplayManager.info("Starting Page Analysis...");

  // 1. Load components.json
  let componentsWhitelist: Set<string>;
  try {
    const componentsFile = file("components.json");
    if (!(await componentsFile.exists())) {
      DisplayManager.error("components.json not found in root directory.");
      process.exit(1);
    }
    const list = await componentsFile.json();
    componentsWhitelist = new Set(list);
  } catch (error) {
    DisplayManager.error(`Error loading components.json: ${error}`);
    process.exit(1);
  }

  // 2. Load master_ids.txt (Optional)
  let masterIds = new Set<string>();
  const runCompliance = args.includes("--compliance");
  if (runCompliance) {
    try {
      const masterFile = file("master_ids.txt");
      if (await masterFile.exists()) {
        const content = await masterFile.text();
        masterIds = new Set(content.split(",").map(id => id.trim()).filter(id => id.length > 0));
        DisplayManager.info(`Loaded ${masterIds.size} approved AD IDs from master_ids.txt`);
      } else {
        DisplayManager.error("master_ids.txt not found. Compliance check skipped.");
      }
    } catch (error) {
      DisplayManager.error(`Error loading master_ids.txt: ${error}`);
    }
  }

  const allReports: ReportNode[] = [];

  // 3. Run Analysis
  for (const pageId of targetIds) {
    DisplayManager.info(`Analyzing Root Page: ${pageId}`);
    const visited = new Set<string>();
    const report = await analyzeItem(pageId, 'PAGE', 'Root Page', visited, componentsWhitelist);
    allReports.push(report);
    
    if (!DisplayManager.isLLM) {
        console.log("\n--- Visual Dependency Tree ---");
        printTree(report);
        console.log("");
    }
  }

  if (DisplayManager.isLLM) {
      DisplayManager.object(allReports);
      return;
  }

  // 4. Final Master Summary
  const masterAds = collectAllAdIds(allReports);
  console.log("===========================================");
  console.log("=== ALL UNIQUE AD IDs ===");
  console.log("===========================================");
  console.log(masterAds.length > 0 ? masterAds.join(", ") : "None found.");
  console.log("===========================================");
  console.log(`Total Count: ${masterAds.length}\n`);

  // 5. Compliance Verification
  if (runCompliance && masterIds.size > 0) {
    DisplayManager.info("Running Compliance Verification...");
    const compliance = verifyCompliance(allReports, masterIds);
    
    console.log("\n-------------------------------------------");
    console.log("DETAILED COMPARISON REPORT");
    console.log("-------------------------------------------");
    console.log(`Common IDs (Master ∩ Generated):  ${compliance.commonIds.length}`);
    console.log(`Rogue IDs  (Generated - Master): ${compliance.rogueIds.length}`);
    console.log(`Missing IDs (Master - Generated): ${compliance.missingIds.length}`);
    console.log("-------------------------------------------");

    if (compliance.isCompliant) {
      DisplayManager.success("COMPLIANCE PASSED: All generated AD IDs are present in the Master List.");
    } else {
      DisplayManager.error("COMPLIANCE FAILED: Rogue AD IDs detected!");
      console.log("\nROGUE ID SOURCES:");
      compliance.rogueIds.forEach(rogue => {
        console.log(`- ${rogue.id} (Found In: ${rogue.foundIn.join(", ")})`);
      });
    }

    if (compliance.missingIds.length > 0) {
      console.log("\nIDs IN MASTER BUT NOT FOUND ON PAGES:");
      console.log(compliance.missingIds.join(", "));
    }
    console.log("-------------------------------------------\n");
  }

  DisplayManager.success("Analysis Complete.");
}