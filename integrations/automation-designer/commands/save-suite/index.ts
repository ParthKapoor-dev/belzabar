import { join } from "path";
import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { InputCollector } from "../../lib/input-collector";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

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

export const args = defineArgs({
  command: "belz ad save-suite",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: {
    ...AD_COMMON_FLAGS,
    name: { type: "string", required: true, missingCode: "MISSING_SUITE_NAME", missingMessage: "--name argument is required." },
    inputs: { type: "string" },
  },
});

const command: CommandModule<SaveSuiteArgs, SaveSuiteData> = {
  schema: "ad.save-suite",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "test", "save-suite");
    return { uuid: positionals.uuid, suiteName: flags.name, inputsFile: flags.inputs };
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
