import { InputCollector } from "../../lib/input-collector";
import { apiFetch, testMethod, fetchMethodDefinition } from "../../lib/api";
import { CacheManager } from "../../lib/cache";
import { parseMethodResponse } from "../../lib/parser";
import { PayloadBuilder } from "../../lib/payload-builder";
import { ErrorParser, type ParsedError } from "../../lib/error-parser";
import type { RawMethodResponse } from "../../lib/types";

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
    console.info(`[Info] Fetching Draft definition for ${uuid}...`);
    const rawMethod = await fetchMethodDefinition(uuid) as RawMethodResponse;
    
    // Parse just to get inputs list
    const hydrated = parseMethodResponse(rawMethod);
    const definedInputs = hydrated.inputs; // These are InputField[]

    // 2. Collect Inputs
    const values = await InputCollector.collect(definedInputs, flags.inputsFile);

    // 3. Construct Payload
    const payload = PayloadBuilder.injectInputs(rawMethod, values);

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
        console.error("\n❌ Method Execution Failed.");
        
        // Identify failing step from services array
        const failingSvc = result.services?.find((s: any) => s.executionStatus?.failed);
        const failingIndex = result.services?.findIndex((s: any) => s.executionStatus?.failed);
        
        if (failingSvc && failingSvc.executionStatus) {
            const parsedErr = ErrorParser.parse(failingSvc.executionStatus);
            const svcName = failingSvc.description || "Service";
            
            console.log(`\nStep: [${failingIndex !== -1 ? failingIndex + 1 : "?"}] ${svcName}`);
            console.log(`Error: ${parsedErr.summary}`);
            console.log(`Details:`);
            console.log(parsedErr.detail.split('\n').map((l: string) => "  " + l).join('\n'));
        }
    } else {
        console.log("✅ Method Executed Successfully.");
    }

    // Show Output (only if success or generic output exists)
    if (!result.executionStatus?.failed && result.outputs && result.outputs.length > 0) {
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
    } else if (!result.executionStatus?.failed) {
        console.log("\n(No Output)\n");
    }

    // Execution Trace
    if (result.services) {
        console.log("\n--- Execution Trace ---");
        
        result.services.forEach((svc: any, idx: number) => {
             let status = "✅ Success";
             let isFailingStep = false;
             let isSkipped = false;

             if (svc.executionStatus?.failed) {
                 status = "❌ Failed";
                 isFailingStep = true;
             } else if (!svc.executionStatus) {
                 status = "⏭️ Skipped";
                 isSkipped = true;
             }

             const time = svc.executionStatus?.executionTime?.totalTime || "0ms";
             console.log(`\n[Step ${idx + 1}] ${svc.description || "Service"} (ID: ${svc.automationId})`);
             console.log(`   Status: ${status} (${time})`);
             
             // Verbose Details: Inputs (Mappings)
             if (flags.verbose && svc.mappings && svc.mappings.length > 0) {
                 console.log(`   Inputs:`);
                 const traverseMappings = (items: any[], indent = "     ") => {
                    items.forEach((m: any) => {
                        if (m.mappings && m.mappings.length > 0) {
                            traverseMappings(m.mappings, indent);
                        }
                        if (m.value !== undefined) {
                            let val = m.value;
                            if (m.encodingType === "BASE_64" && typeof val === 'string') {
                                try {
                                    val = Buffer.from(val, 'base64').toString('utf-8');
                                } catch {
                                    val += " (DECODE FAILED)";
                                }
                            }
                            console.log(`${indent}- Input (${m.automationUserInputId || "N/A"}): ${JSON.stringify(val)}`);
                        }
                    });
                 };
                 traverseMappings(svc.mappings);
             }

             // Handle Error Block for failing step
             if (isFailingStep && svc.executionStatus) {
                 const parsed = ErrorParser.parse(svc.executionStatus);
                 console.log(`   Error: ${parsed.summary}`);
                 console.log(`   Details:`);
                 console.log(parsed.detail.split('\n').map(l => "     " + l).join('\n'));
             }

             // Verbose Details: Outputs (Only if successful)
             if (flags.verbose && !isFailingStep && !isSkipped && svc.outputs && svc.outputs.length > 0) {
                 console.log(`   Outputs:`);
                 svc.outputs.forEach((out: any) => {
                     let val = out.testResult;
                     // Sometimes testResult is JSON string?
                     if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
                         try { val = JSON.parse(val); } catch {}
                     }
                     // Use console.dir for complex objects
                     console.log(`     - ${out.code || "Output"}:`);
                     console.dir(val, { depth: null, colors: true });
                 });
             }
        });
    }

  } catch (error: any) {
    console.error("❌ Error:", error.message || error);
    process.exit(1);
  }
}
