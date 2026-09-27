import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

interface ChildInfoArgs {
  category: string;
  methodName: string;
}

interface ChildInfoData {
  category: string;
  methodName: string;
  body: unknown;
}

export const args = defineArgs({
  command: "belz ad child-info",
  positionals: [
    { name: "category", required: true, missingCode: "MISSING_CATEGORY", missingMessage: "Missing <category> argument." },
    { name: "method-name", required: true, missingCode: "MISSING_METHOD_NAME", missingMessage: "Missing <method-name> argument." },
  ],
  flags: { ...AD_COMMON_FLAGS },
});

const command: CommandModule<ChildInfoArgs, ChildInfoData> = {
  schema: "ad.child-info",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "childInfo", "child-info");
    return { category: positionals.category, methodName: positionals.methodName };
  },
  async execute({ category, methodName }) {
    const body = await adApi.fetchChildMethodInfo(category, methodName);
    return ok<ChildInfoData>({ category, methodName, body });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ChildInfoData;
    ui.section(`${data.category}.${data.methodName}`);
    ui.object(data.body);
  },
};

export default command;
