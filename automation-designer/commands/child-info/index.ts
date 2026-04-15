import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";

interface ChildInfoArgs {
  category: string;
  methodName: string;
}

interface ChildInfoData {
  category: string;
  methodName: string;
  body: unknown;
}

const command: CommandModule<ChildInfoArgs, ChildInfoData> = {
  schema: "ad.child-info",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "childInfo", "child-info");
    emitFallbackWarning(common, "child-info");
    const category = rest[0];
    const methodName = rest[1];
    if (!category || category.startsWith("-")) {
      throw new CliError("Missing <category> argument.", { code: "MISSING_CATEGORY" });
    }
    if (!methodName || methodName.startsWith("-")) {
      throw new CliError("Missing <method-name> argument.", { code: "MISSING_METHOD_NAME" });
    }
    return { category, methodName };
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
