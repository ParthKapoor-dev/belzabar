import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { fetchMethodDefinition, testMethod } from "../../lib/api";
import { PayloadBuilder } from "../../lib/payload-builder";
import type { RawMethodResponse } from "../../lib/types";

export async function run(args: string[]) {
  const suitesDir = join(process.cwd(), "suites");
  
  if (!existsSync(suitesDir)) {
      console.error("No suites directory found.");
      process.exit(1);
  }

  const files = readdirSync(suitesDir).filter(f => f.endsWith(".spec.json"));
  
  if (files.length === 0) {
      console.log("No test suites found.");
      return;
  }

  console.log(`Found ${files.length} test suites.`);
  
  let passed = 0;
  let failed = 0;

  for (const file of files) {
      const suitePath = join(suitesDir, file);
      const suite = await Bun.file(suitePath).json();
      
      console.log(`
🏃 Running Suite: ${suite.name} (${suite.uuid})`);
      
      try {
          // 1. Fetch fresh definition
          const rawMethod = await fetchMethodDefinition(suite.uuid) as RawMethodResponse;
          
          // 2. Inject inputs
          const payload = PayloadBuilder.injectInputs(rawMethod, suite.inputs || {});

          // 3. Prepare FormData
          const formData = new FormData();
          formData.append("body", JSON.stringify(payload));

          // 4. Run Test
          const resultRes = await testMethod(formData);
          
          if (!resultRes.ok) {
              console.error(`  ❌ API Request Failed: ${resultRes.status}`);
              failed++;
              continue;
          }

          const result = await resultRes.json();
          
          if (result.executionStatus?.failed) {
              console.error(`  ❌ Logic Failed: ${JSON.stringify(result.executionStatus.error || "Unknown")}`);
              failed++;
          } else {
              console.log(`  ✅ Success`);
              passed++;
          }

      } catch (e: any) {
          console.error(`  ❌ Error: ${e.message}`);
          failed++;
      }
  }

  console.log(`
---------------------------`);
  console.log(`Summary: ${passed} Passed, ${failed} Failed`);
  
  if (failed > 0) process.exit(1);
}
