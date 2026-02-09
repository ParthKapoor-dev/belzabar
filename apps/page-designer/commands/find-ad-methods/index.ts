import { fetchPageConfig, fetchComponentConfig, fetchComponentIdByName } from "../../lib/api";
import { extractReferences } from "../../lib/parser";
import { analyzeItem } from "../../lib/analyzer";
import { collectAllAdIds } from "../../lib/reporter";
import { file } from "bun";
import { DisplayManager } from "@belzabar/core";

export async function run(args: string[]) {
  const targetId = args[0];
  if (!targetId) {
    DisplayManager.error("Error: Missing Page ID or Component ID argument.");
    process.exit(1);
  }

  const recursive = args.includes("--recursive") || args.includes("-r");
  const type = args.includes("--component") ? "COMPONENT" : "PAGE";

  try {
    let adIds: string[] = [];

    if (recursive) {
      // 1. Load components.json for whitelist
      const componentsFile = file("components.json");
      if (!(await componentsFile.exists())) {
        DisplayManager.error("components.json not found. Required for recursive search.");
        process.exit(1);
      }
      const list = await componentsFile.json();
      const componentsWhitelist = new Set(list);

      DisplayManager.info(`Deep scanning ${type} ${targetId} recursively...`);
      const visited = new Set<string>();
      
      let actualId = targetId;
      if (type === "COMPONENT") {
          const id = await fetchComponentIdByName(targetId);
          if (id) actualId = id;
      }

      const report = await analyzeItem(actualId, type, "Target", visited, componentsWhitelist);
      adIds = collectAllAdIds([report]);
    } else {
      DisplayManager.info(`Scanning ${type} ${targetId}...`);
      const data = type === "PAGE" 
        ? await fetchPageConfig(targetId) 
        : await fetchComponentConfig(targetId);

      if (!data) {
        DisplayManager.error(`Error: Failed to fetch ${type} config.`);
        process.exit(1);
      }

      const refs = extractReferences(data.configuration, new Set());
      adIds = refs.adIds;
    }

    if (DisplayManager.isLLM) {
      DisplayManager.object(adIds);
      return;
    }

    if (adIds.length === 0) {
      DisplayManager.info("No AD method references found.");
    } else {
      console.log(`
Found ${adIds.length} AD method(s):`);
      adIds.forEach(id => console.log(`- ${id}`));
    }

  } catch (error) {
    DisplayManager.error(`Unexpected Error: ${error}`);
    process.exit(1);
  }
}
