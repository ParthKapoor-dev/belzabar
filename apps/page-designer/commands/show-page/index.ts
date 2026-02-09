import { fetchPageConfig } from "../../lib/api";
import { DisplayManager } from "@belzabar/core";

export async function run(args: string[]) {
  const pageId = args[0];
  if (!pageId) {
    DisplayManager.error("Error: Missing Page ID argument.");
    process.exit(1);
  }

  const flags = {
    full: args.includes("--full"),
  };

  try {
    DisplayManager.info(`Fetching page ${pageId}...`);
    const data = await fetchPageConfig(pageId);

    if (!data) {
      DisplayManager.error(`Error: Failed to fetch page config for ${pageId}`);
      process.exit(1);
    }

    if (DisplayManager.isLLM || flags.full) {
      DisplayManager.object(data);
      return;
    }

    DisplayManager.kv("Name", data.name);
    DisplayManager.kv("ID", pageId);
    
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