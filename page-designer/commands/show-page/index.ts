import { CliError, ok, type CommandModule } from "@belzabar/core";
import { fetchPageConfig } from "../../lib/api";
import { extractReferences } from "../../lib/parser";

interface ShowPageArgs {
  pageId: string;
  full: boolean;
  raw: boolean;
}

interface ShowPageData {
  pageId: string;
  name: string;
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

const command: CommandModule<ShowPageArgs, ShowPageData> = {
  schema: "pd.show-page",
  parseArgs(args) {
    const pageId = args[0];
    if (!pageId || pageId.startsWith("-")) {
      throw new CliError("Missing Page ID argument.", { code: "MISSING_PAGE_ID" });
    }
    return {
      pageId,
      full: args.includes("--full"),
      raw: args.includes("--raw"),
    };
  },
  async execute({ pageId, full, raw }) {
    const data = await fetchPageConfig(pageId);
    if (!data) {
      throw new CliError(`Failed to fetch page config for ${pageId}`, {
        code: "PAGE_FETCH_FAILED",
      });
    }

    let configurationParsed: unknown | null = null;
    try {
      configurationParsed = JSON.parse(data.configuration);
    } catch {
      configurationParsed = null;
    }

    const refs = extractReferences(data.configuration, new Set<string>());
    const response: ShowPageData = {
      pageId,
      name: data.name,
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
    const data = envelope.data as ShowPageData;
    ui.table(
      ["Property", "Value"],
      [
        ["Name", data.name],
        ["ID", data.pageId],
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
