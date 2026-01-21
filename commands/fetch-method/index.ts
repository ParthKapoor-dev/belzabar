import { apiFetch } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import type { RawMethodResponse } from "../../lib/types";

export async function run(args: string[]) {
  const targetId = args[0];
  if (!targetId) {
    console.error("Error: Missing UUID argument.");
    console.error("Run 'cli fetch-method --help' for usage.");
    process.exit(1);
  }

  const path = `/rest/api/automation/chain/${targetId}`;
  
  try {
    console.info(`[Info] Fetching method ${targetId}...`);
    const response = await apiFetch(path, {
      method: "GET",
      authMode: "Bearer",
    });

    if (response.status === 404) {
      console.error("❌ Error: 404 Chain Not Found");
      process.exit(1);
    }

    if (!response.ok) {
      console.error(`❌ Error: Request failed ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    const rawData = await response.json() as RawMethodResponse;
    const hydrated = parseMethodResponse(rawData);
    
    await CacheManager.save(targetId, hydrated);

    // Hydrate services
    if (hydrated.services.length > 0) {
      console.log(`[Info] Hydrating ${hydrated.services.length} services...`);
      const uniqueIds = new Set(hydrated.services.map(s => s.automationId));
      for (const id of uniqueIds) {
         await ServiceHydrator.ensureCached(id);
      }
    }

    console.log(`✅ Successfully fetched and cached method: ${hydrated.aliasName}`);
    console.log(`   Version: ${hydrated.state}`);
    console.log(`   UUID: ${hydrated.uuid}`);

  } catch (error) {
    console.error("❌ Unexpected Error:", error);
    process.exit(1);
  }
}
