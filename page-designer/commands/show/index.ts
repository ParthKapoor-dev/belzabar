import { file } from "bun";
import { CliError, Config, ok, openUrlInBrowser, type CommandModule } from "@belzabar/core";
import { analyzeItem } from "../../lib/analyzer";
import {
  extractDirectChildComponentNames,
  extractReferences,
  extractVariables,
  extractHttpSummary,
  extractBindingReferences,
  extractComponentTree,
  extractHttpDetail,
  extractVarDetail,
  parsePage,
  findNode,
  walkParsed,
  type HttpCallDetail,
  type VarDetail,
} from "../../lib/parser/index";
import { resolveInput, type InputKind } from "../../lib/resolver";
import { collectAllAdIds, formatTreeLines } from "../../lib/reporter";
import type {
  PageConfigResponse,
  NormalizedVariable,
  NormalizedDerived,
  HttpCallSummary,
  ComponentTreeNode,
} from "../../lib/types/legacy";
import type { HydratedPage, ParsedNode, NodeKind } from "../../lib/types/common";
import type { RawPageResponse } from "../../lib/types/wire";

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
    // Phase-7 additions
    tree: boolean;               // kind-badge full layout tree
    node: string | null;         // --node <id> detailed node dump
    varGraph: boolean;           // --var-graph variable write/read/derive/trigger map
    open: boolean;               // --open / -o open the editable draft URL in the browser
  };
}

// --- Kind badges for --tree / --llm parsedNodes ---

function kindBadge(kind: NodeKind): string {
  switch (kind) {
    case "FORM_FIELD": return "[FORM]";
    case "DATA_TABLE": return "[TABLE]";
    case "BUTTON": return "[BTN]";
    case "SYMBOL": return "[SYM]";
    case "LAYOUT_CONTAINER": return "[LAYOUT]";
    case "GENERIC": return "[-]";
  }
}

interface TreeLineEntry {
  depth: number;
  nodeId: string;
  kind: NodeKind;
  tagName: string;
  badge: string;
  hasEvents: boolean;
  loop: string | null;
  summary: string;
}

function kindSummary(node: ParsedNode): string {
  switch (node.kind) {
    case "FORM_FIELD":
      return `field.type=${node.fieldType ?? "?"}${node.usesPropsInsteadOfField ? " USES-PROPS!" : ""}${node.valueBinding ? ` ↔${node.valueBinding}` : ""}`;
    case "DATA_TABLE": {
      const cols = node.hasDynamicColumns ? "dyn-cols" : "static-cols";
      const ds = node.datasourceState ?? "NO-DS";
      return `${cols} ds=${ds}${node.rowDataBinding ? ` ←${node.rowDataBinding}` : ""}`;
    }
    case "BUTTON":
      return `"${(node.innerHTML ?? "").slice(0, 30)}"${node.hasDynamicClassName ? " DYN-CLASS!" : ""}`;
    case "SYMBOL":
      return `${node.symbolName} in=${node.inputBindings.length} events=${node.eventWires.length}`;
    case "LAYOUT_CONTAINER":
      return node.layoutProps ? JSON.stringify(node.layoutProps) : "";
    case "GENERIC":
      return node.tagName || "(unknown)";
  }
}

function buildTreeLines(root: ParsedNode): TreeLineEntry[] {
  const out: TreeLineEntry[] = [];
  const walk = (node: ParsedNode, depth: number): void => {
    out.push({
      depth,
      nodeId: node.nodeId,
      kind: node.kind,
      tagName: node.tagName,
      badge: kindBadge(node.kind),
      hasEvents: !!(node.events && Object.keys(node.events).length > 0),
      loop: node.loop,
      summary: kindSummary(node),
    });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

// --- Variable dependency graph ---

interface VarGraphEntry {
  name: string;
  kind: "user-defined" | "derived";
  type: string | null;
  // Who writes this variable
  writtenByHttp: Array<{ callLabel: string; callIndex: number }>;
  writtenByEvents: Array<{ nodeId: string; event: string }>;
  // Who reads this variable
  readByBindings: Array<{ nodeId: string; tagName: string; prop: string }>;
  readByHttpTriggers: Array<{ callLabel: string; callIndex: number }>;
  // Who derives from this (if user-defined) or what this derives from (if derived)
  derivedDependents: string[];        // for user-defined: downstream derived names
  derivedFrom: string[];              // for derived: upstream dependencies
}

function buildVarGraph(page: HydratedPage): VarGraphEntry[] {
  const varByName = new Map<string, VarGraphEntry>();

  for (const v of page.variables) {
    varByName.set(v.name, {
      name: v.name,
      kind: "user-defined",
      type: v.type,
      writtenByHttp: [],
      writtenByEvents: [],
      readByBindings: [],
      readByHttpTriggers: [],
      derivedDependents: [],
      derivedFrom: [],
    });
  }
  for (const d of page.derived) {
    varByName.set(d.name, {
      name: d.name,
      kind: "derived",
      type: null,
      writtenByHttp: [],
      writtenByEvents: [],
      readByBindings: [],
      readByHttpTriggers: [],
      derivedDependents: [],
      derivedFrom: d.from,
    });
    for (const upstream of d.from) {
      const up = varByName.get(upstream);
      if (up) up.derivedDependents.push(d.name);
    }
  }

  // HTTP writes (success mappings) + reads (triggers)
  for (const call of page.httpRequests) {
    for (const m of call.successMappings) {
      const entry = varByName.get(m.variable);
      if (entry) entry.writtenByHttp.push({ callLabel: call.label, callIndex: call.index });
    }
    if (call.inProgressVar) {
      const entry = varByName.get(call.inProgressVar);
      if (entry) entry.writtenByHttp.push({ callLabel: call.label, callIndex: call.index });
    }
    for (const trig of call.triggers) {
      const entry = varByName.get(trig);
      if (entry) entry.readByHttpTriggers.push({ callLabel: call.label, callIndex: call.index });
    }
  }

  // Bindings + events across layout tree
  walkParsed(page.layout, (node) => {
    // prop bindings like [rowData]: "{%data%}" or innerHTML: "{%x%}"
    for (const [prop, raw] of Object.entries(node.props)) {
      if (typeof raw !== "string") continue;
      const regex = /\{%([^%]+)%\}/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(raw)) !== null) {
        const ref = m[1];
        if (!ref) continue;
        const entry = varByName.get(ref);
        if (entry) entry.readByBindings.push({ nodeId: node.nodeId, tagName: node.tagName, prop });
      }
    }
    // events: handler entries are arrays that contain variable writes.
    if (node.events && typeof node.events === "object") {
      for (const [eventName, handlers] of Object.entries(node.events)) {
        if (!Array.isArray(handlers)) continue;
        for (const h of handlers) {
          if (Array.isArray(h) && typeof h[0] === "string") {
            // handler target like "this.varName" or "{%varName%}"
            const target = h[0] as string;
            const thisMatch = target.match(/^this\.(.+)$/);
            const tplMatch = target.match(/\{%([^%]+)%\}/);
            const name = thisMatch?.[1] ?? tplMatch?.[1];
            if (name) {
              const entry = varByName.get(name);
              if (entry) entry.writtenByEvents.push({ nodeId: node.nodeId, event: eventName });
            }
          }
        }
      }
    }
  });

  return Array.from(varByName.values());
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
    status: string | null;
    draftId: string | null;
    publishedId: string | null;
    versionId: string | number | null;
    editUrl: string | null;
    configSizeBytes: number;
    topLevelKeys: string[];
    userDefinedVarCount: number;
    derivedVarCount: number;
    httpCallCount: number;
    directChildComponents: Array<{ name: string }>;
    adMethodIds: string[];
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
  // Phase-7 additions
  tree?: TreeLineEntry[];
  nodeDetail?: {
    nodeId: string;
    kind: NodeKind;
    tagName: string;
    summary: string;
    props: Record<string, unknown>;
    events: Record<string, unknown> | null;
    loop: string | null;
    childCount: number;
    specific?: Record<string, unknown>; // kind-specific detail
  };
  varGraph?: VarGraphEntry[];
  parseWarnings?: string[];
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
  // The PD API returns ONE entity (draft OR published) plus a `referenceId`
  // pointing at the other version. Use `status` to disambiguate — otherwise a
  // queried PUBLISHED entity's own id gets mislabeled as the Draft ID because
  // `id` falls through both lookups.
  const status =
    typeof source.status === "string" ? source.status.toUpperCase() : null;
  const ownId =
    (pickFirstDeep(source, ["id", "uuid"]) as string | null) ?? fallbackId;
  const refId = pickFirstDeep(source, [
    "referenceId", "referenceID", "reference_id",
    "publishedId", "publishedID", "published_id",
    "publishId", "serviceChainUID",
  ]) as string | null;

  const isPublished = status === "PUBLISHED";
  return {
    status,
    draftId: isPublished ? refId : ownId,
    publishedId: isPublished ? ownId : refId,
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
      tree: args.includes("--tree"),
      node: null as string | null,
      varGraph: args.includes("--var-graph"),
      open: args.includes("--open") || args.includes("-o"),
    };

    const varIdx = args.indexOf("--var-detail");
    const varDetailArg = varIdx !== -1 ? args[varIdx + 1] : undefined;
    if (varDetailArg) {
      flags.varDetail = varDetailArg;
    }

    const httpIdx = args.indexOf("--http-detail");
    const httpDetailArg = httpIdx !== -1 ? args[httpIdx + 1] : undefined;
    if (httpDetailArg) {
      flags.httpDetail = parseInt(httpDetailArg, 10);
      if (Number.isNaN(flags.httpDetail)) {
        throw new CliError("--http-detail requires a valid numeric index.", {
          code: "INVALID_HTTP_DETAIL",
        });
      }
    }

    const nodeIdx = args.indexOf("--node");
    const nodeArg = nodeIdx !== -1 ? args[nodeIdx + 1] : undefined;
    if (nodeArg) {
      flags.node = nodeArg;
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
    // Build the editable-draft URL. PD pages route by draft id; symbols/
    // components route by name (the UI resolves the name to the draft).
    const editUrl = (() => {
      const base = Config.cleanBaseUrl;
      if (entityType === "COMPONENT") {
        return `${base}/ui-designer/symbol/${encodeURIComponent(resolvedName)}`;
      }
      const draftId = (rawMetadata.draftId as string | null) ?? resolvedId;
      return `${base}/ui-designer/page/${draftId}`;
    })();

    const directChildComponents = childNames.map(name => ({ name }));

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
        status: rawMetadata.status,
        draftId: rawMetadata.draftId as string | null,
        publishedId: rawMetadata.publishedId as string | null,
        versionId: rawMetadata.versionId,
        editUrl,
        configSizeBytes: Buffer.byteLength(configStr, "utf-8"),
        topLevelKeys:
          configurationParsed && typeof configurationParsed === "object" && !Array.isArray(configurationParsed)
            ? Object.keys(configurationParsed as Record<string, unknown>)
            : [],
        userDefinedVarCount: vars.userDefined.length,
        derivedVarCount: vars.derived.length,
        httpCallCount: httpCalls.length,
        directChildComponents,
        adMethodIds: refs.adIds,
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

    // ----- Phase-7 additions: tree / node / var-graph / parseWarnings --------
    const needHydrated = flags.tree || !!flags.node || flags.varGraph || flags.full;
    if (needHydrated) {
      const page: HydratedPage = parsePage(response as unknown as RawPageResponse);
      if (page.parseWarnings.length > 0) data.parseWarnings = page.parseWarnings;

      if (flags.tree || flags.full) {
        data.tree = buildTreeLines(page.layout);
      }

      if (flags.node) {
        const match = findNode(page.layout, flags.node);
        if (!match) {
          throw new CliError(`Node "${flags.node}" not found in layout tree.`, {
            code: "NODE_NOT_FOUND",
          });
        }
        const specific: Record<string, unknown> = {};
        switch (match.kind) {
          case "FORM_FIELD":
            specific.field = match.field;
            specific.fieldType = match.fieldType;
            specific.valueBinding = match.valueBinding;
            specific.validations = match.validations;
            specific.usesPropsInsteadOfField = match.usesPropsInsteadOfField;
            break;
          case "DATA_TABLE":
            specific.datasourceState = match.datasourceState;
            specific.hasDynamicColumns = match.hasDynamicColumns;
            specific.hasInitialValueOnColumnsVar = match.hasInitialValueOnColumnsVar;
            specific.rowDataBinding = match.rowDataBinding;
            specific.columnsRaw = match.columnsRaw;
            break;
          case "BUTTON":
            specific.innerHTML = match.innerHTML;
            specific.hasDynamicClassName = match.hasDynamicClassName;
            break;
          case "SYMBOL":
            specific.symbolName = match.symbolName;
            specific.inputBindings = match.inputBindings;
            specific.eventWires = match.eventWires;
            break;
          case "LAYOUT_CONTAINER":
            specific.layoutProps = match.layoutProps;
            specific.isRoot = match.isRoot;
            break;
        }
        data.nodeDetail = {
          nodeId: match.nodeId,
          kind: match.kind,
          tagName: match.tagName,
          summary: kindSummary(match),
          props: match.props,
          events: match.events,
          loop: match.loop,
          childCount: match.children.length,
          specific,
        };
      }

      if (flags.varGraph || flags.full) {
        data.varGraph = buildVarGraph(page);
      }
    }

    if (flags.open) {
      try {
        await openUrlInBrowser(editUrl);
      } catch (err) {
        // Don't fail the command if launching the browser fails — surface
        // the URL via the table/JSON output instead.
        context.warn(`--open failed: ${(err as Error).message}. URL: ${editUrl}`);
      }
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
        ["Status", s.status ?? "UNKNOWN"],
        ["Resolved ID", s.resolvedId],
        ["Draft ID", s.draftId ?? "N/A"],
        ["Published ID", s.publishedId ?? "N/A"],
        ["Version ID", s.versionId ?? "N/A"],
        ["Edit URL", s.editUrl ?? "N/A"],
        ["Config Size", `${s.configSizeBytes} bytes`],
        ["Variables", `${s.userDefinedVarCount} user-defined, ${s.derivedVarCount} derived`],
        ["HTTP Calls", s.httpCallCount],
        ["Child Components", s.directChildComponents.length],
        ["AD Methods", s.adMethodIds.length],
        ["Source", data.source],
      ]
    );

    if (s.directChildComponents.length > 0) {
      ui.section("Direct Child Components");
      ui.table(
        ["#", "Component Name"],
        s.directChildComponents.map((c, idx) => [idx + 1, c.name])
      );
    }

    if (s.adMethodIds.length > 0) {
      ui.section("Direct AD Method IDs");
      ui.table(
        ["#", "Method ID"],
        s.adMethodIds.map((id, idx) => [idx + 1, id])
      );
    }

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

    // --tree (kind-badge layout tree)
    if (data.tree) {
      ui.section("Layout Tree");
      for (const entry of data.tree) {
        const indent = "  ".repeat(entry.depth);
        const badges =
          entry.badge +
          (entry.loop ? " [loop]" : "") +
          (entry.hasEvents ? " [events]" : "");
        ui.text(`${indent}${badges} ${entry.tagName}#${entry.nodeId} — ${entry.summary}`);
      }
    }

    // --node <id>
    if (data.nodeDetail) {
      const n = data.nodeDetail;
      ui.section(`Node Detail: ${n.nodeId} ${kindBadge(n.kind)} ${n.tagName}`);
      ui.kv("Kind", n.kind);
      ui.kv("Summary", n.summary);
      ui.kv("Children", n.childCount);
      if (n.loop) ui.kv("Loop", n.loop);
      if (n.events) {
        ui.section("Events");
        ui.object(n.events);
      }
      if (n.specific && Object.keys(n.specific).length > 0) {
        ui.section("Kind-specific");
        ui.object(n.specific);
      }
      ui.section("Props");
      ui.object(n.props);
    }

    // --var-graph
    if (data.varGraph) {
      ui.section("Variable Graph");
      if (data.varGraph.length === 0) {
        ui.text("No variables defined.");
      } else {
        for (const v of data.varGraph) {
          const parts: string[] = [`[${v.kind}]`];
          parts.push(v.name);
          if (v.type) parts.push(`(${v.type})`);
          ui.text(parts.join(" "));
          if (v.writtenByHttp.length > 0) {
            ui.text(`  ← written by HTTP: ${v.writtenByHttp.map((w) => `#${w.callIndex} ${w.callLabel}`).join(", ")}`);
          }
          if (v.writtenByEvents.length > 0) {
            ui.text(`  ← written by events: ${v.writtenByEvents.map((w) => `${w.nodeId}.${w.event}`).join(", ")}`);
          }
          if (v.readByBindings.length > 0) {
            ui.text(`  → read by ${v.readByBindings.length} binding(s): ${v.readByBindings.slice(0, 3).map((r) => `${r.tagName}#${r.nodeId}.${r.prop}`).join(", ")}${v.readByBindings.length > 3 ? "…" : ""}`);
          }
          if (v.readByHttpTriggers.length > 0) {
            ui.text(`  → triggers HTTP: ${v.readByHttpTriggers.map((t) => `#${t.callIndex} ${t.callLabel}`).join(", ")}`);
          }
          if (v.derivedDependents.length > 0) {
            ui.text(`  → derives: ${v.derivedDependents.join(", ")}`);
          }
          if (v.derivedFrom.length > 0) {
            ui.text(`  ← derived from: ${v.derivedFrom.join(", ")}`);
          }
          const isDead =
            v.writtenByHttp.length + v.writtenByEvents.length === 0 &&
            v.readByBindings.length + v.readByHttpTriggers.length + v.derivedDependents.length === 0;
          if (isDead) ui.text(`  ⚠ dead — no writers AND no readers`);
        }
      }
    }

    // Parse warnings (always surface when present)
    if (data.parseWarnings && data.parseWarnings.length > 0) {
      ui.section("Parse Warnings");
      for (const w of data.parseWarnings) ui.text(`⚠ ${w}`);
    }

    // Hints for available flags
    if (
      !data.vars && !data.http && !data.components && !data.varDetail &&
      !data.httpDetail && !data.tree && !data.nodeDetail && !data.varGraph
    ) {
      ui.info("Use --vars, --http, --components, --tree, --var-graph, --node <id>, or --full for more detail.");
    }
  },
};

export default command;
