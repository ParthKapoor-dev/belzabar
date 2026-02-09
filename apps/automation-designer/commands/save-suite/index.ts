import { InputCollector } from "../../lib/input-collector";
import { fetchMethodDefinition } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";
import { join } from "path";

export async function run(args: string[]) {
  const uuid = args[0];
  if (!uuid || uuid.startsWith("-")) {
    console.error("Error: Missing UUID argument.");
    process.exit(1);
  }

  const nameIdx = args.indexOf("--name");
  if (nameIdx === -1 || !args[nameIdx + 1]) {
    console.error("Error: --name argument is required.");
    process.exit(1);
  }
  const suiteName = args[nameIdx + 1];

  const inputsFileIdx = args.indexOf("--inputs");
  const inputsFile = inputsFileIdx !== -1 ? args[inputsFileIdx + 1] : undefined;

  console.info(`[Info] Fetching definition for ${uuid}...`);
  try {
    const rawMethod = await fetchMethodDefinition(uuid);
    const hydrated = parseMethodResponse(rawMethod);
    
    console.log(`[Suite] Creating suite for: ${hydrated.methodName} (${uuid})`);

    const values = await InputCollector.collect(hydrated.inputs, inputsFile);

    const suite = {
      name: suiteName,
      uuid: uuid,
      description: `Test suite for ${hydrated.methodName}`,
      inputs: values
    };

    const suitePath = join(process.cwd(), "suites", `${suiteName}.spec.json`);
    await Bun.write(suitePath, JSON.stringify(suite, null, 2));
    
    console.log(`✅ Suite saved to: ${suitePath}`);

  } catch (error: any) {
    console.error("❌ Error:", error.message || error);
    process.exit(1);
  }
}
