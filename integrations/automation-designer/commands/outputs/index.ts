import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveMethodRef } from "../../lib/ids";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

interface OutputsArgs {
  uuid: string;
  apiVersion: "v1" | "v2";
}

interface OutputsData {
  uuid: string;
  name: string;
  sourceVersion: "v1" | "v2";
  inputs: Array<{ code: string; type: string; required: boolean; description: string }>;
  variables: Array<{ code: string; type: string; description: string }>;
  outputs: Array<{ code: string; type: string; displayName: string; description: string }>;
}

export const args = defineArgs({
  command: "belz ad outputs",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: { ...AD_COMMON_FLAGS },
});

const command: CommandModule<OutputsArgs, OutputsData> = {
  schema: "ad.outputs",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    const common = resolveAdCommon(flags, "fetch", "outputs");
    return { uuid: resolveMethodRef(positionals.uuid), apiVersion: common.apiVersion.version };
  },
  async execute({ uuid, apiVersion }) {
    const m = await adApi.fetchMethod(uuid, apiVersion);
    return ok<OutputsData>({
      uuid,
      name: m.name,
      sourceVersion: m.sourceVersion,
      inputs: m.inputs.map(i => ({
        code: i.code,
        type: String(i.type ?? ""),
        required: !!i.required,
        description: i.description ?? "",
      })),
      variables: m.variables.map(v => ({
        code: v.code,
        type: String(v.type ?? ""),
        description: v.description ?? "",
      })),
      outputs: m.outputs.map(o => ({
        code: o.code,
        type: String(o.type ?? ""),
        displayName: o.displayName ?? o.code,
        description: o.description ?? "",
      })),
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as OutputsData;
    ui.section(`${data.name} — Contract`);
    ui.section("Inputs");
    if (data.inputs.length === 0) ui.text("(none)");
    else ui.table(["Field", "Type", "Required", "Description"], data.inputs.map(i => [i.code, i.type, i.required ? "Yes" : "No", i.description]));
    ui.section("Variables");
    if (data.variables.length === 0) ui.text("(none)");
    else ui.table(["Field", "Type", "Description"], data.variables.map(v => [v.code, v.type, v.description]));
    ui.section("Outputs");
    if (data.outputs.length === 0) ui.text("(none)");
    else ui.table(["Code", "Display Name", "Type", "Description"], data.outputs.map(o => [o.code, o.displayName, o.type, o.description]));
  },
};

export default command;
