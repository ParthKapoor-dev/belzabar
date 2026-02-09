import { file } from "bun";
import { TARGET_PAGE_IDS } from "./src/config";
import { analyzeItem } from "./src/analyzer";
import { printTree, collectAllAdIds } from "./src/reporter";
import { verifyCompliance } from "./src/comparator";
import type { ReportNode } from "./src/types";

/**
 * MAIN ENTRY POINT
 */

async function main() {
  console.log("🚀 Starting High-Concurrency Page Analysis...");
  console.log("-------------------------------------------\n");

  // 1. Load components.json
  let componentsWhitelist: Set<string>;
  try {
    const componentsFile = file("components.json");
    if (!(await componentsFile.exists())) {
      console.error("❌ Error: components.json not found in root directory.");
      process.exit(1);
    }
    const list = await componentsFile.json();
    componentsWhitelist = new Set(list);
  } catch (error) {
    console.error("❌ Error loading components.json:", error);
    process.exit(1);
  }

  // 2. Load master_ids.txt (Optional but recommended for Compliance)
  let masterIds = new Set<string>();
  try {
    const masterFile = file("master_ids.txt");
    if (await masterFile.exists()) {
      const content = await masterFile.text();
      masterIds = new Set(content.split(",").map(id => id.trim()).filter(id => id.length > 0));
      console.log(`✅ Loaded ${masterIds.size} approved AD IDs from master_ids.txt\n`);
    } else {
      console.warn("⚠️ Warning: master_ids.txt not found. Compliance check will be skipped.\n");
    }
  } catch (error) {
    console.error("❌ Error loading master_ids.txt:", error);
  }

  const allReports: ReportNode[] = [];

  // 3. Run Analysis for all target pages
  for (const pageId of TARGET_PAGE_IDS) {
    console.log(`📡 Analyzing Root Page: ${pageId}`);
    const visited = new Set<string>();
    const report = await analyzeItem(pageId, 'PAGE', 'Root Page', visited, componentsWhitelist);
    allReports.push(report);
    
    console.log("\n--- Visual Dependency Tree ---");
    printTree(report);
    console.log("");
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
  if (masterIds.size > 0) {
    console.log("⚖️ Running Compliance Verification...");
    const compliance = verifyCompliance(allReports, masterIds);
    
    console.log("\n-------------------------------------------");
    console.log("DETAILED COMPARISON REPORT");
    console.log("-------------------------------------------");
    console.log(`Common IDs (Master ∩ Generated):  ${compliance.commonIds.length}`);
    console.log(`Rogue IDs  (Generated - Master): ${compliance.rogueIds.length}`);
    console.log(`Missing IDs (Master - Generated): ${compliance.missingIds.length}`);
    console.log("-------------------------------------------");

    if (compliance.isCompliant) {
      console.log("\x1b[32m%s\x1b[0m", "✅ COMPLIANCE PASSED: All generated AD IDs are present in the Master List.");
    } else {
      console.log("\x1b[31m%s\x1b[0m", "❌ COMPLIANCE FAILED: Rogue AD IDs detected!");
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

  console.log("✅ Analysis Complete.");
}

main();
