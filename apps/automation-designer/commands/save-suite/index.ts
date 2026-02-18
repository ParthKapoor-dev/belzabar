import { join } from "path";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { InputCollector } from "../../lib/input-collector";
import { fetchMethodDefinition } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";

interface SaveSuiteArgs {
  uuid: string;
  suiteName: string;
  inputsFile?: string;
}

interface SaveSuiteData {
  suitePath: string;
  suiteName: string;
  uuid: string;
  methodName: string;
  inputCount: number;
}

const command: CommandModule<SaveSuiteArgs, SaveSuiteData> = {
  schema: "ad.save-suite",
  parseArgs(args) {
    const uuid = args[0];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }

    const nameIdx = args.indexOf("--name");
    if (nameIdx === -1 || !args[nameIdx + 1]) {
      throw new CliError("--name argument is required.", { code: "MISSING_SUITE_NAME" });
    }

    const inputsFileIdx = args.indexOf("--inputs");
    const inputsFile = inputsFileIdx !== -1 ? args[inputsFileIdx + 1] : undefined;

    return {
      uuid,
      suiteName: args[nameIdx + 1],
      inputsFile,
    };
  },
  async execute({ uuid, suiteName, inputsFile }) {
    const rawMethod = await fetchMethodDefinition(uuid);
    const hydrated = parseMethodResponse(rawMethod);
    const values = await InputCollector.collect(hydrated.inputs, inputsFile);

    const suite = {
      name: suiteName,
      uuid,
      description: `Test suite for ${hydrated.methodName}`,
      inputs: values,
    };

    const suitePath = join(process.cwd(), "suites", `${suiteName}.spec.json`);
    await Bun.write(suitePath, JSON.stringify(suite, null, 2));

    return ok({
      suitePath,
      suiteName,
      uuid,
      methodName: hydrated.methodName,
      inputCount: Object.keys(values ?? {}).length,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as SaveSuiteData;
    ui.success(`Suite saved: ${data.suiteName}`);
    ui.table(
      ["Property", "Value"],
      [
        ["Method", data.methodName],
        ["UUID", data.uuid],
        ["Inputs Captured", data.inputCount],
        ["Path", data.suitePath],
      ]
    );
  },
};

export default command;
