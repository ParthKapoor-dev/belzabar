import { file } from "bun";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { analyzeItem } from "../../lib/analyzer";
import { fetchEntityIdsByName } from "../../lib/api";
import {
  extractDirectChildComponentNames,
  extractReferences,
  extractVariables,
  extractHttpSummary,
  extractBindingReferences,
  extractComponentTree,
  extractHttpDetail,
  extractVarDetail,
  type HttpCallDetail,
  type VarDetail,
} from "../../lib/parser";
import { resolveInput, type InputKind } from "../../lib/resolver";
import { collectAllAdIds, formatTreeLines } from "../../lib/reporter";
import type {
  PageConfigResponse,
  NormalizedVariable,
  NormalizedDerived,
  HttpCallSummary,
  ComponentTreeNode,
} from "../../lib/types";

// --- Args ---

interface ShowArgs {
  input: string;
  flags: {
    vars: boolean;
    http: boolean;
    components: boolean;
    full: boolean;
    force: boolean;
    raw: boolean;
    recursive: boolean;
    varDetail: string | null;
    httpDetail: number;
  };
}

// --- Data ---

interface ShowData {
  request: {
    input: string;
    inputKind: InputKind;
    entityType: "PAGE" | "COMPONENT";
    flags: ShowArgs["flags"];
  };
  source: "cache" | "fresh";
  summary: {
    name: string;
    entityType: "PAGE" | "COMPONENT";
    resolvedId: string;
    draftId: string | null;
    publishedId: string | null;
    versionId: string | number | null;
    configSizeBytes: number;
    topLevelKeys: string[];
    userDefinedVarCount: number;
    derivedVarCount: number;
    httpCallCount: number;
    childComponentCount: number;
    adMethodCount: number;
  };
  vars?: {
    userDefined: NormalizedVariable[];
    derived: NormalizedDerived[];
  };
  http?: HttpCallSummary[];
  components?: ComponentTreeNode | null;
  varDetail?: VarDetail | null;
  httpDetail?: HttpCallDetail | null;
  recursive?: {
    treeLines: string[];
    uniqueAdMethodIds: string[];
  };
  raw?: {
    configurationRaw: string;
    sourceFields: Record<string, unknown>;
  };
}

// --- Helpers ---

function toRecord(data: PageConfigResponse): Record<string, unknown> {
  return data as unknown as Record<string, unknown>;
}

function pickFirstDeep(input: unknown, keys: string[], maxDepth = 5): string | number | null {
  const queue: Array<{ node: unknown; depth: number }> = [{ node: input, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { node, depth } = current;
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number") return value;
    }
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
      "publishedId", "publishedID", "published_id", "serviceChainUID",
      "publishId", "referenceId", "referenceID", "reference_id",
    ]) as string | null,
    versionId: pickFirstDeep(source, ["versionId", "versionID", "version_id", "version"]),
  };
}

function truncate(value: unknown, maxLen = 80): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (!str) return "(null)";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}

function formatTreeIndented(node: ComponentTreeNode, prefix = "", isLast = true, isRoot = true): string[] {
  const connector = isRoot ? "" : isLast ? "└── " : "├── ";
  const symbol = node.isSymbol ? " [symbol]" : "";
  const events = node.hasEvents ? " [events]" : "";
  const line = `${prefix}${connector}${node.name}${symbol}${events}`;
  const lines = [line];
  const childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "│   ");
  node.children.forEach((child, i) => {
    lines.push(...formatTreeIndented(child, childPrefix, i === node.children.length - 1, false));
  });
  return lines;
}

// --- Command ---

const command: CommandModule<ShowArgs, ShowData> = {
  schema: "pd.show",
  parseArgs(args) {
    const input = args[0];
    if (!input || input.startsWith("-")) {
      throw new CliError(
        "Missing argument. Provide a page URL, PD designer URL, page/component ID, or component name.",
        { code: "MISSING_INPUT" }
      );
    }

    const flags = {
      vars: args.includes("--vars"),
      http: args.includes("--http"),
      components: args.includes("--components"),
      full: args.includes("--full"),
      force: args.includes("--force"),
      raw: args.includes("--raw"),
      recursive: args.includes("--recursive") || args.includes("-r"),
      varDetail: null as string | null,
      httpDetail: -1,
    };

    const varIdx = args.indexOf("--var-detail");
    if (varIdx !== -1 && args[varIdx + 1]) {
      flags.varDetail = args[varIdx + 1];
    }

    const httpIdx = args.indexOf("--http-detail");
    if (httpIdx !== -1 && args[httpIdx + 1]) {
      flags.httpDetail = parseInt(args[httpIdx + 1], 10);
      if (Number.isNaN(flags.httpDetail)) {
        throw new CliError("--http-detail requires a valid numeric index.", {
          code: "INVALID_HTTP_DETAIL",
        });
      }
    }

    return { input, flags };
  },

  async execute({ input, flags }, context) {
    const resolved = await resolveInput(input, flags.force);
    const { entityType, resolvedId, response, inputKind, source } = resolved;
    const configStr = response.configuration;

    if (source === "cache") {
      context.warn("Using cached config. Use --force for refresh.");
    }

    let configurationParsed: unknown | null = null;
    try {
      configurationParsed = JSON.parse(configStr);
    } catch {
      configurationParsed = null;
    }

    const resolvedName = response.name || resolvedId;
    const refs = extractReferences(configStr, new Set<string>());
    const childNames = extractDirectChildComponentNames(configStr);
    const vars = extractVariables(configStr);
    const httpCalls = extractHttpSummary(configStr);

    const sourceFields = toRecord(response);
    const rawMetadata = extractMetadata(sourceFields, resolvedId);
    const enrichedIds = await fetchEntityIdsByName(resolvedName, entityType);

    const includeVars = flags.vars || flags.full;
    const includeHttp = flags.http || flags.full;
    const includeComponents = flags.components || flags.full;

    const data: ShowData = {
      request: { input, inputKind, entityType, flags },
      source,
      summary: {
        name: resolvedName,
        entityType,
        resolvedId,
        draftId: (enrichedIds.draftId ?? rawMetadata.draftId) as string | null,
        publishedId: (enrichedIds.publishedId ?? rawMetadata.publishedId) as string | null,
        versionId: rawMetadata.versionId,
        configSizeBytes: Buffer.byteLength(configStr, "utf-8"),
        topLevelKeys:
          configurationParsed && typeof configurationParsed === "object" && !Array.isArray(configurationParsed)
            ? Object.keys(configurationParsed as Record<string, unknown>)
            : [],
        userDefinedVarCount: vars.userDefined.length,
        derivedVarCount: vars.derived.length,
        httpCallCount: httpCalls.length,
        childComponentCount: childNames.length,
        adMethodCount: refs.adIds.length,
      },
    };

    if (includeVars) {
      data.vars = vars;
    }

    if (includeHttp) {
      data.http = httpCalls;
    }

    if (includeComponents) {
      data.components = extractComponentTree(configStr);
    }

    if (flags.varDetail) {
      data.varDetail = extractVarDetail(configStr, flags.varDetail);
      if (!data.varDetail) {
        throw new CliError(`Variable "${flags.varDetail}" not found.`, { code: "VAR_NOT_FOUND" });
      }
    }

    if (flags.httpDetail >= 1) {
      data.httpDetail = extractHttpDetail(configStr, flags.httpDetail);
      if (!data.httpDetail) {
        throw new CliError(`HTTP call #${flags.httpDetail} not found. Valid range: 1-${httpCalls.length}`, {
          code: "HTTP_NOT_FOUND",
        });
      }
    }

    if (flags.recursive) {
      const componentsFile = file("components.json");
      if (!(await componentsFile.exists())) {
        throw new CliError("components.json not found. Required for recursive inspection.", {
          code: "COMPONENTS_FILE_MISSING",
        });
      }
      const list = await componentsFile.json();
      const componentsWhitelist = new Set(list);
      const visited = new Set<string>();
      const tree = await analyzeItem(resolvedId, entityType, resolvedName, visited, componentsWhitelist);
      data.recursive = {
        treeLines: formatTreeLines(tree),
        uniqueAdMethodIds: collectAllAdIds([tree]),
      };
    }

    if (flags.raw) {
      const safeSourceFields = Object.fromEntries(
        Object.entries(sourceFields).filter(([key]) => key !== "configuration")
      );
      data.raw = {
        configurationRaw: configStr,
        sourceFields: safeSourceFields,
      };
    }

    return ok(data);
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ShowData;
    const s = data.summary;

    // Always: overview table
    ui.table(
      ["Property", "Value"],
      [
        ["Name", s.name],
        ["Entity Type", s.entityType],
        ["Resolved ID", s.resolvedId],
        ["Draft ID", s.draftId ?? "N/A"],
        ["Published ID", s.publishedId ?? "N/A"],
        ["Version ID", s.versionId ?? "N/A"],
        ["Config Size", `${s.configSizeBytes} bytes`],
        ["Variables", `${s.userDefinedVarCount} user-defined, ${s.derivedVarCount} derived`],
        ["HTTP Calls", s.httpCallCount],
        ["Child Components", s.childComponentCount],
        ["AD Methods", s.adMethodCount],
        ["Source", data.source],
      ]
    );

    // --vars
    if (data.vars) {
      ui.section("User-Defined Variables");
      if (data.vars.userDefined.length === 0) {
        ui.text("None.");
      } else {
        ui.table(
          ["#", "Name", "Type", "Initial Value"],
          data.vars.userDefined.map((v, i) => [
            i + 1,
            v.name,
            v.type ?? "—",
            truncate(v.initialValue, 60),
          ])
        );
      }

      ui.section("Derived Variables");
      if (data.vars.derived.length === 0) {
        ui.text("None.");
      } else {
        ui.table(
          ["#", "Name", "Dependencies", "Side Effect"],
          data.vars.derived.map((d, i) => [
            i + 1,
            d.name,
            d.from.join(", ") || "none",
            d.sideEffect ? "Yes" : "No",
          ])
        );
      }
    }

    // --http
    if (data.http) {
      ui.section("HTTP Service Calls");
      if (data.http.length === 0) {
        ui.text("None.");
      } else {
        ui.table(
          ["#", "Label", "AD ID", "Method", "Triggers", "Outputs"],
          data.http.map(h => [
            h.index,
            h.label,
            h.adId ?? "N/A",
            h.method ?? "N/A",
            h.triggers.join(", ") || "none",
            h.outputBindings.join(", ") || "none",
          ])
        );
      }
    }

    // --components
    if (data.components) {
      ui.section("Component Tree");
      const lines = formatTreeIndented(data.components);
      for (const line of lines) {
        ui.text(line);
      }
    }

    // --var-detail
    if (data.varDetail) {
      const v = data.varDetail;
      ui.section(`Variable Detail: ${v.name}`);
      ui.kv("Kind", v.kind);
      if (v.type) ui.kv("Type", v.type);

      if (v.kind === "user-defined") {
        ui.kv("Initial Value", JSON.stringify(v.initialValue, null, 2));
      }

      if (v.kind === "derived") {
        ui.kv("Dependencies", (v.from ?? []).join(", "));
        ui.kv("Side Effect", v.sideEffect ? "Yes" : "No");
        if (v.spec) {
          ui.section("Spec (code)");
          ui.text(v.spec);
        }
        if (v.filterFn) {
          ui.section("Filter Function");
          ui.text(v.filterFn);
        }
      }

      if (v.bindingReferences.length > 0) {
        ui.kv("Used In", v.bindingReferences.join(", "));
      }
    }

    // --http-detail
    if (data.httpDetail) {
      const h = data.httpDetail;
      ui.section(`HTTP Call Detail: #${h.index} — ${h.label}`);
      ui.table(
        ["Property", "Value"],
        [
          ["Label", h.label],
          ["AD ID", h.adId ?? "N/A"],
          ["Service UUID", h.serviceUuid ?? "N/A"],
          ["Method", h.method ?? "N/A"],
          ["URL", h.url ?? "N/A"],
          ["Triggers", h.triggers.join(", ") || "none"],
          ["In-Progress Var", h.inProgressVar ?? "N/A"],
          ["Has Event Meta", h.hasEventMeta ? (h.eventMetaEmpty ? "Yes (empty!)" : "Yes") : "No"],
        ]
      );

      if (h.inputBindings.length > 0) {
        ui.section("Input Bindings");
        ui.table(
          ["Field Code", "Binding Variable"],
          h.inputBindings.map(b => [b.fieldCode, b.bindingVariable])
        );
      }

      if (h.successMappings.length > 0) {
        ui.section("Success Mappings");
        ui.table(
          ["Variable", "Expression"],
          h.successMappings.map(m => [m.variable, m.expression])
        );
      }

      if (h.triggerFilter) {
        ui.section("Trigger Filter");
        ui.text(h.triggerFilter);
      }

      if (h.responseTransformSpec) {
        ui.section("Response Transform");
        ui.text(h.responseTransformSpec);
      }
    }

    // --recursive
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

    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }

    // Hints for available flags
    if (!data.vars && !data.http && !data.components && !data.varDetail && !data.httpDetail) {
      ui.info("Use --vars, --http, --components, or --full for more detail.");
    }
  },
};

export default command;
