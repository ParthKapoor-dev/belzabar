import { InputCollector } from "../../lib/input-collector";
import { apiFetch, testMethod } from "../../lib/api";
import { CacheManager } from "../../lib/cache";
import { parseMethodResponse } from "../../lib/parser";
import type { RawMethodResponse } from "../../lib/types";

async function fetchMethod(uuid: string, force = false) {
  // We need the RAW response because we need to modify the jsonDefinition string
  // and send the whole object back. Cache stores Hydrated.
  // So for testing, we might prefer fetching fresh or caching RAW as well.
  // Given the "Draft" nature, fetching fresh is safer/better.
  // But let's check cache first for metadata/inputs logic if we want.
  // However, since we need to send the exact structure back, let's fetch fresh.
  
  console.info(`[Info] Fetching Draft definition for ${uuid}...`);
  const path = `/rest/api/automation/chain/${uuid}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch method: ${response.status} ${response.statusText}`);
  }
  return await response.json() as RawMethodResponse;
}

export async function run(args: string[]) {
  const uuid = args[0];
  if (!uuid || uuid.startsWith("-")) {
    console.error("Error: Missing UUID argument.");
    process.exit(1);
  }

  const flags = {
    inputsFile: args.indexOf("--inputs") !== -1 ? args[args.indexOf("--inputs") + 1] : undefined,
    verbose: args.includes("--verbose"),
    force: args.includes("--force")
  };

  try {
    // 1. Fetch Definition
    const rawMethod = await fetchMethod(uuid, flags.force);
    
    // Parse just to get inputs list
    const hydrated = parseMethodResponse(rawMethod);
    const definedInputs = hydrated.inputs; // These are InputField[]

    // 2. Collect Inputs
    const values = await InputCollector.collect(definedInputs, flags.inputsFile);

    // 3. Construct Payload
    // We need to inject values into the inner jsonDefinition
    let innerDef: any = {};
    try {
        innerDef = JSON.parse(rawMethod.jsonDefinition);
    } catch (e) {
        throw new Error("Failed to parse method jsonDefinition.");
    }

    if (innerDef.inputs) {
        innerDef.inputs = innerDef.inputs.map((inp: any) => {
            if (values.hasOwnProperty(inp.fieldCode)) {
                return { ...inp, testValue: values[inp.fieldCode] };
            }
            return inp;
        });
    }

    // Update the raw object
    const payload = { ...rawMethod };
    payload.jsonDefinition = JSON.stringify(innerDef);

    const formData = new FormData();
    formData.append("body", JSON.stringify(payload));

    // 4. Execute Test
    console.log("\n🚀 Executing Method...");
    const resultRes = await testMethod(formData);

    if (!resultRes.ok) {
        console.error(`❌ Execution Failed: ${resultRes.status} ${resultRes.statusText}`);
        const text = await resultRes.text();
        console.error(text);
        process.exit(1);
    }

    const result = await resultRes.json();

    // 5. Display Results
    if (result.executionStatus?.failed) {
        console.error("❌ Method Execution Failed.");
    } else {
        console.log("✅ Method Executed Successfully.");
    }

    // Show Output
    if (result.outputs && result.outputs.length > 0) {
        const testResult = result.outputs[0].testResult;
        console.log("\n--- Final Output ---");
        try {
            // Try to parse if it's a JSON string
            const parsed = typeof testResult === 'string' ? JSON.parse(testResult) : testResult;
            console.dir(parsed, { depth: null, colors: true });
        } catch {
            console.log(testResult);
        }
        console.log("--------------------\n");
    } else {
        console.log("\n(No Output)\n");
    }

    // Verbose Trace
    if (flags.verbose && result.services) {
        console.log("--- Execution Trace ---");
        result.services.forEach((svc: any, idx: number) => {
             const status = svc.executionStatus?.failed ? "❌ Failed" : "✅ Success";
             const time = svc.executionStatus?.executionTime?.totalTime || "0ms";
             console.log(`[Step ${idx + 1}] ${svc.description || "Service"} : ${status} (${time})`);
             
             if (svc.executionStatus?.failed) {
                 console.error(`   Error: ${JSON.stringify(svc.executionStatus.error || "Unknown Error")}`);
             }
        });
    }

  } catch (error: any) {
    console.error("❌ Error:", error.message || error);
    process.exit(1);
  }
}
