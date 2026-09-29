import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { apiShape, fetchAccountLines, type ApiShape } from "../../lib/api-shape";
import { trimUuidPadding } from "@belzabar/core/platform";

interface ChildInfoArgs {
  category: string;
  methodName: string;
  shape: boolean;
  all: boolean;
}

interface ChildInfoData {
  category: string;
  methodName: string;
  body: unknown;
}

type ChildInfoPayload = ChildInfoData | ({ view: "shape" } & ApiShape);

export const args = defineArgs({
  command: "belz ad child-info",
  positionals: [
    { name: "category", required: true, missingCode: "MISSING_CATEGORY", missingMessage: "Missing <category> argument." },
    { name: "method-name", required: true, missingCode: "MISSING_METHOD_NAME", missingMessage: "Missing <method-name> argument." },
  ],
  flags: {
    shape: { type: "boolean" },
    all: { type: "boolean" },
  },
});

const command: CommandModule<ChildInfoArgs, ChildInfoPayload> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    if (flags.all && !flags.shape) {
      throw new CliError("--all only applies with --shape.", { code: "INVALID_ARGUMENT" });
    }
    return { category: positionals.category, methodName: positionals.methodName, shape: flags.shape, all: flags.all };
  },
  async execute({ category, methodName, shape, all }) {
    const body = await adApi.fetchChildMethodInfo(category, methodName);
    // F23: the server answers an unknown (or draft-only) method with 200 + null.
    if (body == null || (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0)) {
      throw new CliError(
        `No published method '${methodName}' in category '${category}' (child-info resolves published methods only).`,
        { code: "METHOD_NOT_FOUND", details: { category, methodName } },
      );
    }
    if (!shape) return ok<ChildInfoPayload>({ category, methodName, body: trimUuidPadding(body) });

    // 7.5: only what wiring a step needs; accounts as id + nickname (never values).
    const view = apiShape(body, category, methodName, { all });
    const accounts = await fetchAccountLines(category).catch(() => []);
    if (accounts.length) view.accounts = accounts;
    return ok<ChildInfoPayload>({ view: "shape", ...view });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ChildInfoPayload;
    if ("view" in data) {
      ui.section(`${data.service}/${data.method}${data.state ? ` [${data.state}]` : ""}`);
      if (data.apiUuid) ui.kv("automationAPIId", data.apiUuid);
      if (data.apiId !== undefined) ui.kv("API id", data.apiId);
      if (data.methodUuid) ui.kv("Method uuid", data.methodUuid);
      ui.section("Inputs (V2 step keys)");
      ui.text(data.inputs.length ? data.inputs.map((l) => `  ${l}`).join("\n") : "  (none)");
      if (data.hiddenInputs) ui.text(`  (+${data.hiddenInputs} hidden inputs — --all to list)`);
      ui.section("Outputs");
      ui.text(data.outputs.length ? data.outputs.map((l) => `  ${l}`).join("\n") : "  (none)");
      if (data.accounts) {
        ui.section("Accounts");
        ui.text(data.accounts.map((l) => `  ${l}`).join("\n"));
      }
      return;
    }
    ui.section(`${data.category}.${data.methodName}`);
    ui.object(data.body);
    ui.info("Tip: --shape prints only the inputs/outputs/accounts a step needs.");
  },
};

export default command;
