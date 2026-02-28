import { file } from "bun";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { fetchPageConfig, fetchComponentConfig, fetchComponentIdByName } from "../../lib/api";
import { extractReferences } from "../../lib/parser";
import { analyzeItem } from "../../lib/analyzer";
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

const command: CommandModule<FindAdMethodsArgs, FindAdMethodsData> = {
  schema: "pd.find-ad-methods",
  parseArgs(args) {
    const targetId = args[0];
    if (!targetId || targetId.startsWith("-")) {
      throw new CliError("Missing Page ID or Component ID argument.", {
        code: "MISSING_TARGET_ID",
      });
    }
    return {
      targetId,
      recursive: args.includes("--recursive") || args.includes("-r"),
      type: args.includes("--component") ? "COMPONENT" : "PAGE",
    };
  },
  async execute({ targetId, recursive, type }) {
    let adIds: string[] = [];

    if (recursive) {
      const componentsFile = file("components.json");
      if (!(await componentsFile.exists())) {
        throw new CliError("components.json not found. Required for recursive search.", {
          code: "COMPONENTS_FILE_MISSING",
        });
      }
      const list = await componentsFile.json();
      const componentsWhitelist = new Set(list);

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
