import { defineSubcommands, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
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

export const args = defineSubcommands(
  {
    create: {
      positionals: [{ name: "name", required: true, missingCode: "MISSING_NAME", missingMessage: "Missing category <name>." }],
      flags: {
        ...AD_COMMON_FLAGS,
        ...AD_YES_FLAG,
        description: { type: "string" },
        private: { type: "boolean" },
      },
    },
  },
  {
    command: "belz ad category",
    codes: { UNKNOWN_SUBCOMMAND: "INVALID_ACTION", MISSING_SUBCOMMAND: "INVALID_ACTION" },
    missingMessage: "Usage: belz ad category create <name> [--description <d>] [--private] [--yes]",
  },
);

const command: CommandModule<CategoryArgs, CategoryData> = {
  schema: "ad.category",
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "category", "category");
    return {
      action: "create",
      name: positionals.name,
      description: flags.description,
      isPrivate: flags.private,
      yes: flags.yes,
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
