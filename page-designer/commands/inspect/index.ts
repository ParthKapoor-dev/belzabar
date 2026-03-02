import { file } from "bun";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { analyzeItem } from "../../lib/analyzer";
import {
  fetchComponentIdByName,
  fetchDeployablePageByAppUrl,
  fetchEntityIdsByName,
} from "../../lib/api";
import { cachedFetchPageConfig as fetchPageConfig, cachedFetchComponentConfig as fetchComponentConfig } from "../../lib/cache";
import { extractDirectChildComponentNames, extractReferences } from "../../lib/parser";
import { collectAllAdIds, formatTreeLines } from "../../lib/reporter";
import type { PageConfigResponse } from "../../lib/types";
import { parsePdUrl } from "../../lib/url-parser";

type InputKind = "app-url" | "pd-url" | "id" | "name";

interface InspectArgs {
  input: string;
  full: boolean;
  raw: boolean;
  recursive: boolean;
}

interface InspectData {
  request: {
    input: string;
    inputKind: InputKind;
    entityType: "PAGE" | "COMPONENT";
  };
  resolved: {
    name: string;
    id: string;
    draftId: string | null;
    publishedId: string | null;
    versionId: string | number | null;
    directChildComponents: string[];
    adMethodIds: string[];
    configParsed: boolean;
    configSizeBytes: number;
    topLevelKeys: string[];
  };
  recursive?: {
    treeLines: string[];
    uniqueAdMethodIds: string[];
  };
  configuration?: unknown;
  raw?: {
    configurationRaw: string;
    sourceFields: Record<string, unknown>;
  };
}

function toRecord(data: PageConfigResponse): Record<string, unknown> {
  return data as unknown as Record<string, unknown>;
}

function pickFirst(record: Record<string, unknown>, keys: string[]): string | number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  return null;
}

function pickFirstDeep(input: unknown, keys: string[], maxDepth = 5): string | number | null {
  const queue: Array<{ node: unknown; depth: number }> = [{ node: input, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { node, depth } = current;
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    const top = pickFirst(record, keys);
    if (top !== null) return top;
    if (depth >= maxDepth) continue;
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") queue.push({ node: value, depth: depth + 1 });
    }
  }
  return null;
}

function extractMetadata(source: Record<string, unknown>, fallbackId: string) {
  return {
    draftId:
      (pickFirstDeep(source, ["draftId", "draftID", "draft_id", "id", "uuid"]) as string | null) ??
      fallbackId,
    publishedId: pickFirstDeep(source, [
      "publishedId",
      "publishedID",
      "published_id",
      "serviceChainUID",
      "publishId",
      "referenceId",
      "referenceID",
      "reference_id",
    ]) as string | null,
    versionId: pickFirstDeep(source, ["versionId", "versionID", "version_id", "version"]),
  };
}

function detectInputKind(input: string): {
  kind: InputKind;
  entityType: "PAGE" | "COMPONENT";
  pdToken?: string;
  domain?: string;
  path?: string;
} {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const pdParsed = parsePdUrl(input);
    if (pdParsed) {
      return {
        kind: "pd-url",
        entityType: pdParsed.type,
        pdToken: pdParsed.token,
      };
    }

    const url = new URL(input);
    const match = url.pathname.match(/^\/pages\/(.+)/);
    if (match) {
      return {
        kind: "app-url",
        entityType: "PAGE",
        domain: url.hostname,
        path: match[1],
      };
    }

    throw new CliError(
      "Unrecognized URL format. Expected a PD designer URL (/ui-designer/page or /ui-designer/symbol) or an app page URL (/pages/...).",
      { code: "INVALID_URL" }
    );
  }

  if (/^[0-9a-f]{32}$/i.test(input)) {
    return { kind: "id", entityType: "PAGE" };
  }

  return { kind: "name", entityType: "COMPONENT" };
}

const command: CommandModule<InspectArgs, InspectData> = {
  schema: "pd.inspect",
  parseArgs(args) {
    const input = args[0];
    if (!input || input.startsWith("-")) {
      throw new CliError(
        "Missing argument. Provide a page URL, PD designer URL, page/component ID, or component name.",
        { code: "MISSING_INPUT" }
      );
    }
    return {
      input,
      full: args.includes("--full"),
      raw: args.includes("--raw"),
      recursive: args.includes("--recursive") || args.includes("-r"),
    };
  },
  async execute({ input, full, raw, recursive }) {
    const detected = detectInputKind(input);
    let entityType: "PAGE" | "COMPONENT" = detected.entityType;
    let resolvedId: string;
    let response: PageConfigResponse | null;

    switch (detected.kind) {
      case "app-url": {
        const refId = await fetchDeployablePageByAppUrl(detected.domain!, detected.path!);
        if (!refId) {
          throw new CliError(
            `No deployed page found for domain '${detected.domain}' at path '${detected.path}'.`,
            { code: "PAGE_NOT_FOUND" }
          );
        }
        resolvedId = refId;
        response = await fetchPageConfig(resolvedId);
        break;
      }

      case "pd-url": {
        if (detected.entityType === "PAGE") {
          resolvedId = detected.pdToken!;
          response = await fetchPageConfig(resolvedId);
        } else {
          const componentId = await fetchComponentIdByName(detected.pdToken!);
          if (!componentId) {
            throw new CliError(`Could not find ID for component '${detected.pdToken}'.`, {
              code: "COMPONENT_NOT_FOUND",
            });
          }
          resolvedId = componentId;
          response = await fetchComponentConfig(resolvedId);
        }
        break;
      }

      case "id": {
        response = await fetchPageConfig(input);
        if (response) {
          resolvedId = input;
          entityType = "PAGE";
        } else {
          response = await fetchComponentConfig(input);
          if (!response) {
            throw new CliError(`No page or component found for ID: ${input}`, {
              code: "NOT_FOUND",
            });
          }
          resolvedId = input;
          entityType = "COMPONENT";
        }
        break;
      }

      case "name": {
        const componentId = await fetchComponentIdByName(input);
        if (!componentId) {
          throw new CliError(`Could not find component '${input}'.`, {
            code: "COMPONENT_NOT_FOUND",
          });
        }
        resolvedId = componentId;
        response = await fetchComponentConfig(resolvedId);
        break;
      }
    }

    if (!response) {
      throw new CliError("Failed to fetch Page Designer configuration.", {
        code: "PD_FETCH_FAILED",
      });
    }

    const resolvedName = response.name || resolvedId!;

    let configurationParsed: unknown | null = null;
    try {
      configurationParsed = JSON.parse(response.configuration);
    } catch {
      configurationParsed = null;
    }

    const refs = extractReferences(response.configuration, new Set<string>());
    const directChildComponents = extractDirectChildComponentNames(response.configuration);
    const sourceFields = toRecord(response);
    const rawMetadata = extractMetadata(sourceFields, resolvedId!);
    const enrichedIds = await fetchEntityIdsByName(resolvedName, entityType);

    const result: InspectData = {
      request: {
        input,
        inputKind: detected.kind,
        entityType,
      },
      resolved: {
        name: resolvedName,
        id: resolvedId!,
        draftId: (enrichedIds.draftId ?? rawMetadata.draftId) as string | null,
        publishedId: (enrichedIds.publishedId ?? rawMetadata.publishedId) as string | null,
        versionId: rawMetadata.versionId,
        directChildComponents,
        adMethodIds: refs.adIds,
        configParsed: configurationParsed !== null,
        configSizeBytes: Buffer.byteLength(response.configuration, "utf-8"),
        topLevelKeys:
          configurationParsed && typeof configurationParsed === "object" && !Array.isArray(configurationParsed)
            ? Object.keys(configurationParsed as Record<string, unknown>)
            : [],
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
      const visited = new Set<string>();
      const tree = await analyzeItem(resolvedId!, entityType, resolvedName, visited, componentsWhitelist);
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
        sourceFields: safeSourceFields,
      };
    }

    return ok(result);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as InspectData;
    const r = data.resolved;

    ui.table(
      ["Property", "Value"],
      [
        ["Name", r.name],
        ["Entity Type", data.request.entityType],
        ["Input Kind", data.request.inputKind],
        ["Resolved ID", r.id],
        ["Draft ID", r.draftId ?? "N/A"],
        ["Published ID", r.publishedId ?? "N/A"],
        ["Version ID", r.versionId ?? "N/A"],
        ["Config Parsed", r.configParsed ? "Yes" : "No"],
        ["Config Size (bytes)", r.configSizeBytes],
        ["Direct Child Components", r.directChildComponents.length],
        ["Direct AD Method Refs", r.adMethodIds.length],
      ]
    );

    if (r.directChildComponents.length > 0) {
      ui.section("Direct Child Components");
      ui.table(
        ["#", "Component Name"],
        r.directChildComponents.map((name, idx) => [idx + 1, name])
      );
    }

    if (r.adMethodIds.length > 0) {
      ui.section("Direct AD Method IDs");
      ui.table(
        ["#", "Method ID"],
        r.adMethodIds.map((id, idx) => [idx + 1, id])
      );
    }

    if (r.topLevelKeys.length > 0) {
      ui.section("Top-level Config Keys");
      ui.text(r.topLevelKeys.join(", "));
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
