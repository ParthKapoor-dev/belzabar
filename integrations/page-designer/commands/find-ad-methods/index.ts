import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { fetchComponentIdByName } from "../../lib/api/index";
import { cachedFetchPageConfig as fetchPageConfig, cachedFetchComponentConfig as fetchComponentConfig } from "../../lib/cache";
import { extractReferences } from "../../lib/parser/index";
import { analyzeItem, loadComponentsWhitelist } from "../../lib/analyzer";
import { collectAllAdIds } from "../../lib/reporter";

interface FindAdMethodsArgs {
  targetId: string;
  recursive: boolean;
  type: "PAGE" | "COMPONENT";
}

interface FindAdMethodsData {
  targetId: string;
  type: "PAGE" | "COMPONENT";
  recursive: boolean;
  adIds: string[];
}

export const args = defineArgs({
  command: "belz pd find-ad-methods",
  positionals: [
    { name: "id", required: true, missingCode: "MISSING_TARGET_ID", missingMessage: "Missing Page ID or Component ID argument." },
  ],
  flags: {
    component: { type: "boolean" },
    recursive: { type: "boolean", alias: ["-r"] },
  },
});

const command: CommandModule<FindAdMethodsArgs, FindAdMethodsData> = {
  schema: "pd.find-ad-methods",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return {
      targetId: positionals.id,
      recursive: flags.recursive,
      type: flags.component ? "COMPONENT" : "PAGE",
    };
  },
  async execute({ targetId, recursive, type }) {
    let adIds: string[] = [];

    if (recursive) {
      const componentsWhitelist = await loadComponentsWhitelist("components.json not found. Required for recursive search.");

      let actualId = targetId;
      if (type === "COMPONENT") {
        const id = await fetchComponentIdByName(targetId);
        if (id) actualId = id;
      }

      const visited = new Set<string>();
      const report = await analyzeItem(actualId, type, "Target", visited, componentsWhitelist);
      adIds = collectAllAdIds([report]);
    } else {
      const data = type === "PAGE" ? await fetchPageConfig(targetId) : await fetchComponentConfig(targetId);
      if (!data) {
        throw new CliError(`Failed to fetch ${type} config.`, {
          code: "CONFIG_FETCH_FAILED",
        });
      }
      const refs = extractReferences(data.configuration, new Set());
      adIds = refs.adIds;
    }

    return ok({
      targetId,
      type,
      recursive,
      adIds,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as FindAdMethodsData;
    if (data.adIds.length === 0) {
      ui.info("No AD method references found.");
      return;
    }
    ui.table(
      ["#", "AD Method ID"],
      data.adIds.map((id, idx) => [idx + 1, id])
    );
    ui.text(`Total: ${data.adIds.length}`);
  },
};

export default command;
