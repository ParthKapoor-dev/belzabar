import { fetchComponentIdByName, fetchComponentConfig } from "../../lib/api";
import { DisplayManager } from "@belzabar/core";

export async function run(args: string[]) {
  const compName = args[0];
  if (!compName) {
    DisplayManager.error("Error: Missing Component Name argument.");
    process.exit(1);
  }

  const flags = {
    full: args.includes("--full"),
  };

  try {
    DisplayManager.info(`Searching for component '${compName}'...`);
    const compId = await fetchComponentIdByName(compName);

    if (!compId) {
      DisplayManager.error(`Error: Could not find ID for component '${compName}'`);
      process.exit(1);
    }

    DisplayManager.info(`Fetching configuration for ID ${compId}...`);
    const data = await fetchComponentConfig(compId);

    if (!data) {
      DisplayManager.error(`Error: Failed to fetch configuration for ${compId}`);
      process.exit(1);
    }

    if (DisplayManager.isLLM || flags.full) {
      DisplayManager.object(data);
      return;
    }

    DisplayManager.kv("Name", data.name);
    DisplayManager.kv("ID", compId);
    
    try {
        const config = JSON.parse(data.configuration);
        console.log("\nConfiguration (Parsed):");
        DisplayManager.object(config);
    } catch {
        console.log("\nConfiguration (Raw):");
        console.log(data.configuration);
    }

  } catch (error) {
    DisplayManager.error(`Unexpected Error: ${error}`);
    process.exit(1);
  }
}