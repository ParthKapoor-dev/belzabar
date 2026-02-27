import { file } from "bun";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { analyzeItem } from "../../lib/analyzer";
import {
  fetchComponentConfig,
  fetchComponentIdByName,
  fetchEntityIdsByName,
  fetchPageConfig,
} from "../../lib/api";
import { extractDirectChildComponentNames, extractReferences } from "../../lib/parser";
import { collectAllAdIds, formatTreeLines } from "../../lib/reporter";
import type { PageConfigResponse } from "../../lib/types";
import { parsePdUrl } from "../../lib/url-parser";

interface InspectUrlArgs {
  inputUrl: string;
  full: boolean;
  raw: boolean;
  recursive: boolean;
}

interface InspectUrlData {
  request: {
    url: string;
    type: "PAGE" | "COMPONENT";
    token: string;
    host: string;
    path: string;
  };
  resolved: {
    name: string;
    pageId?: string;
    componentName?: string;
    componentId?: string;
  };
  metadata: {
    draftId: string | number | null;
    publishedId: string | number | null;
    versionId: string | number | null;
  };
  summary: {
    parsed: boolean;
    sizeBytes: number;
    topLevelKeys: string[];
    directChildComponents: string[];
    adMethodIds: string[];
  };
  recursive?: {
    treeLines: string[];
    uniqueAdMethodIds: string[];
  };
  configuration?: unknown;
  raw?: {
    configurationRaw: string;
    parsedUrl: {
      host: string;
      path: string;
      type: "PAGE" | "COMPONENT";
      token: string;
    };
    sourceFields: Record<string, unknown>;
  };
}

function toRecord(data: PageConfigResponse): Record<string, unknown> {
  return data as unknown as Record<string, unknown>;
}

function pickFirst(record: Record<string, unknown>, keys: string[]): string | number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      return value;
    }
  }
  return null;
}

function pickFirstDeep(
  input: unknown,
  keys: string[],
  maxDepth = 5
): string | number | null {
  const queue: Array<{ node: unknown; depth: number }> = [{ node: input, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { node, depth } = current;
    if (!node || typeof node !== "object") continue;

    const record = node as Record<string, unknown>;
    const topLevel = pickFirst(record, keys);
    if (topLevel !== null) return topLevel;

    if (depth >= maxDepth) continue;

    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }

  return null;
}

function extractMetadata(
  source: Record<string, unknown>,
  fallbackDraftId: string
): InspectUrlData["metadata"] {
  return {
    draftId:
      pickFirstDeep(source, ["draftId", "draftID", "draft_id", "id", "uuid"]) ?? fallbackDraftId,
    publishedId: pickFirstDeep(source, [
      "publishedId",
      "publishedID",
      "published_id",
      "serviceChainUID",
      "publishId",
      "referenceId",
      "referenceID",
      "reference_id",
    ]),
    versionId: pickFirstDeep(source, ["versionId", "versionID", "version_id", "version"]),
  };
}

const command: CommandModule<InspectUrlArgs, InspectUrlData> = {
  schema: "pd.inspect-url",
  parseArgs(args) {
    const inputUrl = args[0];
    if (!inputUrl || inputUrl.startsWith("-")) {
      throw new CliError("Missing Page Designer URL argument.", {
        code: "MISSING_PD_URL",
      });
    }

    const parsed = parsePdUrl(inputUrl);
    if (!parsed) {
      throw new CliError(
        "Invalid Page Designer URL. Expected /ui-designer/page/<id> or /ui-designer/symbol/<name>.",
        { code: "INVALID_PD_URL" }
      );
    }

    return {
      inputUrl,
      full: args.includes("--full"),
      raw: args.includes("--raw"),
      recursive: args.includes("--recursive") || args.includes("-r"),
    };
  },
  async execute({ inputUrl, full, raw, recursive }) {
    const parsed = parsePdUrl(inputUrl);
    if (!parsed) {
      throw new CliError("Invalid Page Designer URL.", { code: "INVALID_PD_URL" });
    }

    let resolvedName = parsed.token;
    let resolvedPageId: string | undefined;
    let resolvedComponentName: string | undefined;
    let resolvedComponentId: string | undefined;
    let response: PageConfigResponse | null = null;

    if (parsed.type === "PAGE") {
      resolvedPageId = parsed.token;
      response = await fetchPageConfig(parsed.token);
    } else {
      resolvedComponentName = parsed.token;
      resolvedComponentId = await fetchComponentIdByName(parsed.token) ?? undefined;
      if (!resolvedComponentId) {
        throw new CliError(`Could not find ID for component '${parsed.token}'.`, {
          code: "COMPONENT_NOT_FOUND",
        });
      }
      response = await fetchComponentConfig(resolvedComponentId);
    }

    if (!response) {
      throw new CliError("Failed to fetch Page Designer configuration.", {
        code: "PD_FETCH_FAILED",
      });
    }

    resolvedName = response.name || resolvedName;

    let configurationParsed: unknown | null = null;
    try {
      configurationParsed = JSON.parse(response.configuration);
    } catch {
      configurationParsed = null;
    }

    const refs = extractReferences(response.configuration, new Set<string>());
    const directChildComponents = extractDirectChildComponentNames(response.configuration);
    const sourceFields = toRecord(response);
    const metadata = extractMetadata(
      sourceFields,
      parsed.type === "PAGE" ? parsed.token : resolvedComponentId ?? parsed.token
    );
    const enrichedIds = await fetchEntityIdsByName(resolvedName, parsed.type);

    const finalMetadata: InspectUrlData["metadata"] = {
      draftId: enrichedIds.draftId ?? metadata.draftId,
      publishedId: enrichedIds.publishedId ?? metadata.publishedId,
      versionId: metadata.versionId,
    };

    const result: InspectUrlData = {
      request: {
        url: inputUrl,
        type: parsed.type,
        token: parsed.token,
        host: parsed.host,
        path: parsed.path,
      },
      resolved: {
        name: resolvedName,
        ...(resolvedPageId ? { pageId: resolvedPageId } : {}),
        ...(resolvedComponentName ? { componentName: resolvedComponentName } : {}),
        ...(resolvedComponentId ? { componentId: resolvedComponentId } : {}),
      },
      metadata: finalMetadata,
      summary: {
        parsed: configurationParsed !== null,
        sizeBytes: Buffer.byteLength(response.configuration, "utf-8"),
        topLevelKeys:
          configurationParsed && typeof configurationParsed === "object" && !Array.isArray(configurationParsed)
            ? Object.keys(configurationParsed as Record<string, unknown>)
            : [],
        directChildComponents,
        adMethodIds: refs.adIds,
      },
    };

    if (recursive) {
      const componentsFile = file("components.json");
      if (!(await componentsFile.exists())) {
        throw new CliError("components.json not found. Required for recursive inspection.", {
          code: "COMPONENTS_FILE_MISSING",
        });
      }
      const list = await componentsFile.json();
      const componentsWhitelist = new Set(list);

      const rootId = parsed.type === "PAGE" ? parsed.token : resolvedComponentId!;
      const visited = new Set<string>();
      const tree = await analyzeItem(rootId, parsed.type, resolvedName, visited, componentsWhitelist);

      result.recursive = {
        treeLines: formatTreeLines(tree),
        uniqueAdMethodIds: collectAllAdIds([tree]),
      };
    }

    if (full) {
      result.configuration = configurationParsed ?? response.configuration;
    }

    if (raw) {
      const safeSourceFields = Object.fromEntries(
        Object.entries(sourceFields).filter(([key]) => key !== "configuration")
      );

      result.raw = {
        configurationRaw: response.configuration,
        parsedUrl: {
          host: parsed.host,
          path: parsed.path,
          type: parsed.type,
          token: parsed.token,
        },
        sourceFields: safeSourceFields,
      };
    }

    return ok(result);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as InspectUrlData;

    ui.table(
      ["Property", "Value"],
      [
        ["Name", data.resolved.name],
        ["Type", data.request.type],
        ["URL Token", data.request.token],
        ["Page ID", data.resolved.pageId || "N/A"],
        ["Component Name", data.resolved.componentName || "N/A"],
        ["Component ID", data.resolved.componentId || "N/A"],
        ["Draft ID", data.metadata.draftId ?? "N/A"],
        ["Published ID", data.metadata.publishedId ?? "N/A"],
        ["Version ID", data.metadata.versionId ?? "N/A"],
        ["Config Parsed", data.summary.parsed ? "Yes" : "No"],
        ["Config Size (bytes)", data.summary.sizeBytes],
        ["Direct Child Components", data.summary.directChildComponents.length],
        ["Direct AD Method Refs", data.summary.adMethodIds.length],
      ]
    );

    if (data.summary.directChildComponents.length > 0) {
      ui.section("Direct Child Components");
      ui.table(
        ["#", "Component Name"],
        data.summary.directChildComponents.map((name, idx) => [idx + 1, name])
      );
    }

    if (data.summary.adMethodIds.length > 0) {
      ui.section("Direct AD Method IDs");
      ui.table(
        ["#", "Method ID"],
        data.summary.adMethodIds.map((id, idx) => [idx + 1, id])
      );
    }

    if (data.summary.topLevelKeys.length > 0) {
      ui.section("Top-level Config Keys");
      ui.text(data.summary.topLevelKeys.join(", "));
    }

    if (data.recursive) {
      ui.section("Recursive Dependency Tree");
      data.recursive.treeLines.forEach(line => ui.text(line));

      ui.section("Recursive Unique AD IDs");
      ui.text(
        data.recursive.uniqueAdMethodIds.length > 0
          ? data.recursive.uniqueAdMethodIds.join(", ")
          : "None found."
      );
      ui.text(`Total: ${data.recursive.uniqueAdMethodIds.length}`);
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
