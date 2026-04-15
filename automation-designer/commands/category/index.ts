import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";

interface CategoryArgs {
  action: "create";
  name: string;
  description?: string;
  isPrivate: boolean;
  yes: boolean;
}

interface CategoryData {
  action: "create";
  name: string;
  response: unknown;
}

const command: CommandModule<CategoryArgs, CategoryData> = {
  schema: "ad.category",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "category", "category");
    emitFallbackWarning(common, "category");
    const action = rest[0];
    if (action !== "create") {
      throw new CliError("Usage: belz ad category create <name> [--description <d>] [--private] [--yes]", {
        code: "INVALID_ACTION",
      });
    }
    const name = rest[1];
    if (!name || name.startsWith("-")) {
      throw new CliError("Missing category <name>.", { code: "MISSING_NAME" });
    }
    const descIdx = rest.indexOf("--description");
    return {
      action: "create",
      name,
      description: descIdx !== -1 ? rest[descIdx + 1] : undefined,
      isPrivate: rest.includes("--private"),
      yes: rest.includes("--yes"),
    };
  },
  async execute({ name, description, isPrivate, yes }, context) {
    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `create category "${name}"`,
      details: [
        ["Name", name],
        ["Description", description ?? "(none)"],
        ["Access", isPrivate ? "PRIVATE" : "PUBLIC"],
        ["Permissions", "ALLOW_ALL_INTERNAL_USERS"],
      ],
    });

    logIntent("POST", "/rest/api/automation/chain/category", { name });

    const response = await adApi.createCategory({
      name,
      aliasName: [""],
      description: description ?? "",
      accessMode: isPrivate ? "PRIVATE" : "PUBLIC",
      permissions: [{ permissionType: "ALLOW_ALL_INTERNAL_USERS" }],
      authorizationFields: [],
      securityTags: [],
      templateId: null,
      authenticationStructureInheritedFrom: null,
      isAuthenticationStructureInherited: false,
      authType: null,
    });

    return ok<CategoryData>({ action: "create", name, response });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as CategoryData;
    ui.success(`Created category: ${data.name}`);
    ui.section("Response");
    ui.object(data.response);
  },
};

export default command;
