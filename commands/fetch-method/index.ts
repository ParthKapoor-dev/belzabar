import { apiFetch } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { DisplayManager } from "../../lib/display";
import type { RawMethodResponse } from "../../lib/types";

export async function run(args: string[]) {
  const targetId = args[0];
  if (!targetId) {
    DisplayManager.error("Error: Missing UUID argument.");
    // In LLM mode, this error might be enough, but for human we might want help hint
    if (!DisplayManager.isLLM) console.error("Run 'cli fetch-method --help' for usage.");
    process.exit(1);
  }

  const path = `/rest/api/automation/chain/${targetId}`;
  
  try {
    DisplayManager.info(`Fetching method ${targetId}...`);
    const response = await apiFetch(path, {
      method: "GET",
      authMode: "Bearer",
    });

    if (response.status === 404) {
      DisplayManager.error("Error: 404 Chain Not Found");
      process.exit(1);
    }

    if (!response.ok) {
      DisplayManager.error(`Error: Request failed ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    const rawData = await response.json() as RawMethodResponse;
    const hydrated = parseMethodResponse(rawData);
    
    await CacheManager.save(targetId, hydrated);

    // Hydrate services
    if (hydrated.services.length > 0) {
      DisplayManager.info(`Hydrating ${hydrated.services.length} services...`);
      const uniqueIds = new Set(hydrated.services.map(s => s.automationId));
      for (const id of uniqueIds) {
         await ServiceHydrator.ensureCached(id);
      }
    }

    DisplayManager.success(`Successfully fetched and cached method: ${hydrated.aliasName}`);
    
    if (DisplayManager.isLLM) {
        DisplayManager.object(hydrated);
    } else {
        console.log(`   Version: ${hydrated.state}`);
        console.log(`   UUID: ${hydrated.uuid}`);
    }

  } catch (error) {
    DisplayManager.error(`Unexpected Error: ${error}`);
    process.exit(1);
  }
}
