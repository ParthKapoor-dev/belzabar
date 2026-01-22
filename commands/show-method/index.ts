import chalk from 'chalk';
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { apiFetch } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";
import { DisplayManager } from "../../lib/display";
import type { RawMethodResponse, HydratedMethod } from "../../lib/types";

function formatDate(ts: number): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString();
}

async function fetchAndCache(uuid: string): Promise<HydratedMethod> {
  DisplayManager.info(`Fetching method ${uuid}...`);
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
  DisplayManager.info("Method updated in cache.");
  return hydrated;
}

export async function run(args: string[]) {
  const uuid = args[0];
  if (!uuid || uuid.startsWith("-")) {
    DisplayManager.error("Error: Missing UUID argument.");
    if (!DisplayManager.isLLM) console.error("Run 'belz show-method --help' for usage.");
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
      if (!method) DisplayManager.info("Cache miss or expired.");
      if (flags.force) DisplayManager.info("Forcing refresh.");
      method = await fetchAndCache(uuid);
    }

    if (DisplayManager.isLLM) {
      DisplayManager.object(enrichMethodForLLM(method));
      return;
    }

    if (flags.full) {
      renderFullView(method);
      return;
    }

    // Header / Summary
    DisplayManager.table(
      ['Property', 'Value'],
      [
        ['Method Name', method.methodName],
        ['Alias', method.aliasName],
        ['Category', method.category],
        ['State', method.state],
        ['Version', method.version.toString()],
        ['UUID', method.uuid],
        ['Ref ID', method.referenceId],
        ['Updated', `${formatDate(method.updatedOn)} by ${method.updatedBy}`],
        ['Summary', method.summary || ""]
      ]
    );

    // Inputs
    if (flags.inputs) {
      console.log("\nArgs (Inputs):");
      if (method.inputs.length === 0) {
        console.log("  No inputs defined.");
      } else {
        DisplayManager.table(
          ['Field Code', 'Type', 'Required', 'Description'],
          method.inputs.map(i => [i.fieldCode, i.type, i.required ? "Yes" : "No", i.description || ""])
        );
      }
    }

    // Services
    if (flags.services) {
      console.log("\nService Chain:");
      if (method.services.length === 0) {
        console.log("  No services defined.");
      } else {
        DisplayManager.table(
          ['#', 'ID', 'Type', 'Description'],
          method.services.map(s => [s.orderIndex, s.automationId, s.type, s.description || ""])
        );
      }
    }

    // Service Detail
    if (flags.serviceDetail >= 0) {
      const s = method.services.find(svc => svc.orderIndex === flags.serviceDetail);
      if (!s) {
        DisplayManager.error(`Error: Service with index ${flags.serviceDetail} not found.`);
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
    DisplayManager.error(`Error: ${error.message || error}`);
    process.exit(1);
  }
}

function enrichMethodForLLM(method: HydratedMethod): any {
  // Deep clone to avoid mutating logic elsewhere
  const clone = JSON.parse(JSON.stringify(method));

  if (clone.services) {
    clone.services.forEach((svc: any) => {
      // Decode Custom Code
      if (svc.code) {
        try {
          svc.decodedLogic = Buffer.from(svc.code, 'base64').toString('utf-8');
        } catch {
          svc.decodedLogic = "(Decode Failed)";
        }
      }

      // Decode SQL in Mappings
      if (svc.mappings && Array.isArray(svc.mappings)) {
         const sqlMapping = svc.mappings.find((m: any) => m.mappings && m.mappings.some((sub: any) => sub.encodingType === "BASE_64"));
         if (sqlMapping) {
             const queryItem = sqlMapping.mappings.find((sub: any) => sub.encodingType === "BASE_64");
             if (queryItem && queryItem.value) {
                 try {
                     svc.decodedLogic = Buffer.from(queryItem.value, 'base64').toString('utf-8');
                     svc.logicType = "SQL";
                 } catch {
                     svc.decodedLogic = "(SQL Decode Failed)";
                 }
             }
         }
      }
    });
  }
  return clone;
}

function renderFullView(method: HydratedMethod) {
  // 1. Metadata Table
  console.log(chalk.bold.underline("\nMetadata"));
  DisplayManager.table(
    ['Property', 'Value'],
    [
      ['Name', method.methodName],
      ['Alias', method.aliasName],
      ['UUID', method.uuid],
      ['State', method.state],
      ['Version', method.version.toString()],
      ['Description', method.summary || ""]
    ]
  );

  // 2. Inputs Table
  console.log(chalk.bold.underline("\nInputs"));
  if (method.inputs.length === 0) {
    console.log("  (No Inputs)");
  } else {
    DisplayManager.table(
      ['Code', 'Type', 'Required', 'Description'],
      method.inputs.map(i => [i.fieldCode, i.type, i.required ? "Yes" : "No", i.description || ""])
    );
  }

  // 3. Services Detail
  console.log(chalk.bold.underline(`\nServices (${method.services.length})`));
  
  method.services.forEach((svc, idx) => {
    console.log(chalk.bold(`\n[Step ${svc.orderIndex}] ${svc.description || "Service"} (ID: ${svc.automationId})`));
    
    // Type Detection
    // Try to decode Code
    if ((svc as any).code) {
       console.log(chalk.yellow("  Type: Custom Code (JavaScript)"));
       try {
           const decoded = Buffer.from((svc as any).code, 'base64').toString('utf-8');
           console.log(chalk.gray("  --- Code Logic ---"));
           console.log(decoded);
           console.log(chalk.gray("  ------------------"));
       } catch {
           console.log("  (Code decoding failed)");
       }
    } 
    // Try to decode SQL in mappings
    else if (svc.mappings && Array.isArray(svc.mappings)) {
       // Look for base64 encoded SQL query in mappings
       const sqlMapping = svc.mappings.find((m: any) => m.mappings && m.mappings.some((sub: any) => sub.encodingType === "BASE_64"));
       
       if (sqlMapping) {
           console.log(chalk.yellow("  Type: SQL Query"));
           const queryItem = sqlMapping.mappings.find((sub: any) => sub.encodingType === "BASE_64");
           if (queryItem && queryItem.value) {
               try {
                   const decoded = Buffer.from(queryItem.value, 'base64').toString('utf-8');
                   console.log(chalk.gray("  --- Query ---"));
                   console.log(decoded);
                   console.log(chalk.gray("  -------------"));
               } catch {
                   console.log("  (SQL decoding failed)");
               }
           }
       } else {
           console.log(`  Type: Standard Service`);
       }
    } else {
        console.log(`  Type: Standard Service`);
    }

    // List Outputs
    if (svc.outputs && svc.outputs.length > 0) {
        console.log("  Outputs: " + svc.outputs.map((o: any) => o.code || o.displayName).join(", "));
    }
  });
}
