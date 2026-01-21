import Table from 'cli-table3';
import chalk from 'chalk';
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { apiFetch } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";
import type { RawMethodResponse, HydratedMethod } from "../../lib/types";

function formatDate(ts: number): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString();
}

async function fetchAndCache(uuid: string): Promise<HydratedMethod> {
  console.info(`[Info] Fetching method ${uuid}...`);
  const path = `/rest/api/automation/chain/${uuid}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });

  if (response.status === 404) {
    throw new Error("404 Chain Not Found");
  }
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} ${response.statusText}`);
  }

  const rawData = await response.json() as RawMethodResponse;
  const hydrated = parseMethodResponse(rawData);
  await CacheManager.save(uuid, hydrated);
  console.log("Method updated in cache.");
  return hydrated;
}

export async function run(args: string[]) {
  const uuid = args[0];
  if (!uuid || uuid.startsWith("-")) {
    console.error("Error: Missing UUID argument.");
    console.error("Run 'belz show-method --help' for usage.");
    process.exit(1);
  }

  const flags = {
    inputs: args.includes("--inputs"),
    services: args.includes("--services"),
    full: args.includes("--full"),
    force: args.includes("--force"),
    serviceDetail: -1
  };

  const detailIndex = args.indexOf("--service-detail");
  if (detailIndex !== -1 && args[detailIndex + 1]) {
    flags.serviceDetail = parseInt(args[detailIndex + 1], 10);
  }

  // Helper to truncate long strings in objects for display
  const truncateDeep = (obj: any, maxLength = 100): any => {
    if (typeof obj === 'string') {
      if (obj.length > maxLength) {
        return obj.substring(0, maxLength) + '... (truncated)';
      }
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => truncateDeep(item, maxLength));
    }
    if (obj && typeof obj === 'object') {
      const newObj: any = {};
      for (const key in obj) {
        newObj[key] = truncateDeep(obj[key], maxLength);
      }
      return newObj;
    }
    return obj;
  };

  try {
    let method = await CacheManager.load(uuid);

    if (!method || flags.force) {
      if (!method) console.log("Cache miss or expired.");
      if (flags.force) console.log("Forcing refresh.");
      method = await fetchAndCache(uuid);
    }

    if (flags.full) {
      console.log(JSON.stringify(method, null, 2));
      return;
    }

    // Header / Summary
    const summaryTable = new Table({
      head: ['Property', 'Value'],
      colWidths: [20, 80],
      wordWrap: true
    });

    summaryTable.push(
      ['Method Name', method.methodName],
      ['Alias', method.aliasName],
      ['Category', method.category],
      ['State', method.state],
      ['Version', method.version.toString()],
      ['UUID', method.uuid],
      ['Ref ID', method.referenceId],
      ['Updated', `${formatDate(method.updatedOn)} by ${method.updatedBy}`],
      ['Summary', method.summary || ""]
    );

    console.log(summaryTable.toString());

    // Inputs
    if (flags.inputs) {
      console.log("\nArgs (Inputs):");
      if (method.inputs.length === 0) {
        console.log("  No inputs defined.");
      } else {
        const inputTable = new Table({
          head: ['Field Code', 'Type', 'Required', 'Description'],
          colWidths: [20, 15, 10, 50],
          wordWrap: true
        });
        method.inputs.forEach(i => {
          inputTable.push([i.fieldCode, i.type, i.required ? "Yes" : "No", i.description || ""]);
        });
        console.log(inputTable.toString());
      }
    }

    // Services
    if (flags.services) {
      console.log("\nService Chain:");
      if (method.services.length === 0) {
        console.log("  No services defined.");
      } else {
        const serviceTable = new Table({
          head: ['#', 'ID', 'Type', 'Description'],
          colWidths: [5, 40, 20, 40],
          wordWrap: true
        });
        method.services.forEach(s => {
          serviceTable.push([s.orderIndex, s.automationId, s.type, s.description || ""]);
        });
        console.log(serviceTable.toString());
      }
    }

    // Service Detail
    if (flags.serviceDetail >= 0) {
      const s = method.services.find(svc => svc.orderIndex === flags.serviceDetail);
      if (!s) {
        console.error(`\nError: Service with index ${flags.serviceDetail} not found.`);
      } else {
        const def = await ServiceHydrator.getDefinition(s.automationId);
        
        console.log(`\nService Detail [Index ${s.orderIndex}]:`);
        
        
        if (def) {
          console.log(`Service Category: ${def.automationAPI.automationSystem.label}`);
          console.log(`Method Name:      ${def.automationAPI.label}`);
        } else {
          console.log("Type:", s.type);
          console.log("ID:", s.automationId);
          console.log("Description:", s.description || "");
          console.warn("(Definition not available for deep inspection)");
        }
        
        console.log("\nInputs:");

        if (def) {
          const allInputs = ServiceHydrator.flattenInputs(def);
          const instanceValues = new Map<string, any>();
          
          const mapInstanceValues = (items: any[]) => {
            if (!Array.isArray(items)) return;
            for (const item of items) {
               if (item.automationUserInputId) {
                 instanceValues.set(String(item.automationUserInputId), item);
               }
               if (item.mappings) {
                 mapInstanceValues(item.mappings);
               }
            }
          };
          
          if (s.mappings) {
             const items = Array.isArray(s.mappings) ? s.mappings : Object.values(s.mappings);
             mapInstanceValues(items);
          }

          let inputIdx = 1;

          // 1. Manually add Account if it exists in definition/auth
          if (def.automationAuth?.nickname) {
             const labelStr = `Account` + chalk.red("*");
             const padding = 30 - "Account".length - 1;
             const padStr = padding > 0 ? " ".repeat(padding) : " ";
             console.log(`  ${inputIdx++}. ${labelStr}${padStr}: ${JSON.stringify(def.automationAuth.nickname)}`);
          }

          // 2. Filter to root-level inputs (depth 0) to match UI and reduce clutter
          // Also filter out hidden inputs (showOnSDUi: false)
          const rootInputs = allInputs.filter(i => i.depth === 0 && !i.hidden);

          for (const inputDef of rootInputs) {
            if (!inputDef.label) continue;

            const instanceItem = instanceValues.get(String(inputDef.id));
            let displayValue = "null";

            if (instanceItem && instanceItem.value !== undefined) {
               displayValue = instanceItem.value;
               
               const isBase64 = instanceItem.encodingType === "BASE_64" || inputDef.encoding === "BASE_64";
               if (isBase64 && typeof instanceItem.value === 'string') {
                  try {
                     displayValue = Buffer.from(instanceItem.value, 'base64').toString('utf-8');
                  } catch {
                     displayValue = instanceItem.value + " (DECODE FAILED)";
                  }
               }
               displayValue = JSON.stringify(displayValue);
            } else {
               displayValue = chalk.gray("null");
            }

            const labelStr = inputDef.label + (inputDef.required ? chalk.red("*") : "");
            const padding = 30 - inputDef.label.length - (inputDef.required ? 1 : 0);
            const padStr = padding > 0 ? " ".repeat(padding) : " ";
            
            console.log(`  ${inputIdx++}. ${labelStr}${padStr}: ${displayValue}`);
          }

        } else {
            console.log("  (Definition missing, showing raw mappings)");
            if (s.mappings) console.log(JSON.stringify(truncateDeep(s.mappings), null, 2));
            else console.log("  (None)");
        }

        console.log("\nOutputs:");
        if (s.outputs && def && def.automationAPI.automationAPIOutputs) {
             const outputsArr = Array.isArray(s.outputs) ? s.outputs : Object.values(s.outputs);
             let outputIdx = 1;
             
             // Filter outputs that should be shown on UI
             const visibleOutputs = def.automationAPI.automationAPIOutputs.filter(o => o.showOnUi !== false);

             for (const outDef of visibleOutputs) {
                const instanceOut = outputsArr.find((o: any) => String(o.automationAPIOutputId) === String(outDef.id));
                const val = instanceOut ? instanceOut.code : chalk.gray("null");
                console.log(`  ${outputIdx++}. ${outDef.displayName.padEnd(20)}: ${val}`);
             }
        } else if (s.outputs) {
             console.log(JSON.stringify(s.outputs, null, 2));
        } else {
            console.log("  (None)");
        }
      }
    }

  } catch (error: any) {
    console.error("❌ Error:", error.message || error);
    process.exit(1);
  }
}
