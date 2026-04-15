import { join } from "path";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { InputCollector } from "../../lib/input-collector";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";

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
    const { common, rest } = parseAdCommonArgs(args, "test", "save-suite");
    emitFallbackWarning(common, "save-suite");

    const uuid = rest[0];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }

    const nameIdx = rest.indexOf("--name");
    const name = nameIdx !== -1 ? rest[nameIdx + 1] : undefined;
    if (!name) {
      throw new CliError("--name argument is required.", { code: "MISSING_SUITE_NAME" });
    }

    const inputsFileIdx = rest.indexOf("--inputs");
    const inputsFile = inputsFileIdx !== -1 ? rest[inputsFileIdx + 1] : undefined;

    return { uuid, suiteName: name, inputsFile };
  },
  async execute({ uuid, suiteName, inputsFile }) {
    const method = await adApi.fetchMethod(uuid, "v1");
    const values = await InputCollector.collect(method.inputs, inputsFile);

    const suite = {
      name: suiteName,
      uuid,
      description: `Test suite for ${method.name}`,
      inputs: values,
    };

    const suitePath = join(process.cwd(), "suites", `${suiteName}.spec.json`);
    await Bun.write(suitePath, JSON.stringify(suite, null, 2));

    return ok({
      suitePath,
      suiteName,
      uuid,
      methodName: method.name,
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
