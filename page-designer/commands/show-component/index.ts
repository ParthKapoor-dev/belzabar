import { CliError, ok, type CommandModule } from "@belzabar/core";
import { fetchComponentIdByName, fetchComponentConfig } from "../../lib/api";
import { extractReferences } from "../../lib/parser";

interface ShowComponentArgs {
  componentName: string;
  full: boolean;
  raw: boolean;
}

interface ShowComponentData {
  componentName: string;
  componentId: string;
  resolvedName: string;
  configSummary: {
    parsed: boolean;
    sizeBytes: number;
    topLevelKeys: string[];
    adMethodIds: string[];
  };
  configuration?: unknown;
  raw?: {
    configurationRaw: string;
  };
}

const command: CommandModule<ShowComponentArgs, ShowComponentData> = {
  schema: "pd.show-component",
  parseArgs(args) {
    const componentName = args[0];
    if (!componentName || componentName.startsWith("-")) {
      throw new CliError("Missing Component Name argument.", { code: "MISSING_COMPONENT_NAME" });
    }
    return {
      componentName,
      full: args.includes("--full"),
      raw: args.includes("--raw"),
    };
  },
  async execute({ componentName, full, raw }) {
    const componentId = await fetchComponentIdByName(componentName);
    if (!componentId) {
      throw new CliError(`Could not find ID for component '${componentName}'`, {
        code: "COMPONENT_NOT_FOUND",
      });
    }

    const data = await fetchComponentConfig(componentId);
    if (!data) {
      throw new CliError(`Failed to fetch configuration for ${componentId}`, {
        code: "COMPONENT_FETCH_FAILED",
      });
    }

    let configurationParsed: unknown | null = null;
    try {
      configurationParsed = JSON.parse(data.configuration);
    } catch {
      configurationParsed = null;
    }

    const refs = extractReferences(data.configuration, new Set<string>());
    const response: ShowComponentData = {
      componentName,
      componentId,
      resolvedName: data.name,
      configSummary: {
        parsed: configurationParsed !== null,
        sizeBytes: Buffer.byteLength(data.configuration, "utf-8"),
        topLevelKeys:
          configurationParsed && typeof configurationParsed === "object" && !Array.isArray(configurationParsed)
            ? Object.keys(configurationParsed as Record<string, unknown>)
            : [],
        adMethodIds: refs.adIds,
      },
    };

    if (full) {
      response.configuration = configurationParsed ?? data.configuration;
    }

    if (raw) {
      response.raw = {
        configurationRaw: data.configuration,
      };
    }

    return ok(response);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ShowComponentData;
    ui.table(
      ["Property", "Value"],
      [
        ["Name", data.resolvedName],
        ["Lookup", data.componentName],
        ["ID", data.componentId],
        ["Config Parsed", data.configSummary.parsed ? "Yes" : "No"],
        ["Config Size (bytes)", data.configSummary.sizeBytes],
        ["AD Method Refs", data.configSummary.adMethodIds.length],
      ]
    );

    if (data.configSummary.adMethodIds.length > 0) {
      ui.section("Referenced AD Methods");
      ui.table(
        ["#", "Method ID"],
        data.configSummary.adMethodIds.map((id, idx) => [idx + 1, id])
      );
    }

    if (data.configSummary.topLevelKeys.length > 0) {
      ui.section("Top-level Config Keys");
      ui.text(data.configSummary.topLevelKeys.join(", "));
    }

    if (data.configuration !== undefined) {
      ui.section("Configuration");
      ui.object(data.configuration);
    } else {
      ui.info("Configuration body omitted. Use --full to include it.");
    }

    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
