import { CliError, type CommandModule, Config, defineArgs, isObj, ok, openUrlInBrowser, pickFields, strOrNull, triggerDetachedRefresh } from "@belzabar/core";
import { PD_FORCE_FLAG } from "../../lib/args/common";
import { analyzeItem, cacheDeps, collectAllAdIds, formatTreeLines, type AnalyzeError } from "../../lib/analyzer";
import {
  adIdsOf,
  childComponentNames,
  componentTree,
  findNodes,
  httpDetail,
  httpSummary,
  variablesView,
  varDetail,
  type ComponentTreeNode,
  type FoundNode,
  type HttpCallDetail,
  type VarDetail,
} from "../../lib/extract";
import { findNode, parsePage, walkParsed } from "../../lib/parser/index";
import { resolveInput, type InputKind } from "../../lib/resolver";
import { pdCacheDir } from "../../lib/cache";
import type { HydratedPage, ParsedNode, NodeKind, RawPageResponse } from "../../lib/types/common";

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
    find: string | null;         // --find <text|id|component>
    fields: string[] | null;     // --fields a,b,… (vars / http rows); ["all"] = every field
  };
}

// --- Compact rows ---
//
// --vars / --http rows carry only the fields an agent needs to pick the next
// call; empty values (null, "", [], {}) are omitted. `--fields a,b` picks
// fields explicitly (full values), `--fields all` = every field.

const VAR_FIELDS = ["name", "type", "initialValue", "from", "spec", "filterFn", "sideEffect"] as const;
const HTTP_FIELDS = ["index", "label", "callId", "adId", "serviceUuid", "method", "triggers", "outputs", "inProgressVar", "eventMeta"] as const;
const DEFAULT_VAR_FIELDS = ["name", "type", "initialValue"];
const DEFAULT_DERIVED_FIELDS = ["name", "from", "sideEffect"];
const DEFAULT_HTTP_FIELDS = ["index", "label", "callId", "adId", "triggers", "outputs"];
/** A default-mode initialValue longer than this (JSON) is replaced by `initialValueBytes`. */
const SHORT_VALUE = 80;

type Row = Record<string, unknown>;

function parseFields(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const list = raw.split(",").map((f) => f.trim()).filter(Boolean);
  if (list.includes("all")) return ["all"];
  const known = new Set<string>([...VAR_FIELDS, ...HTTP_FIELDS]);
  const bad = list.filter((f) => !known.has(f));
  if (bad.length || list.length === 0) {
    throw new CliError(`--fields: unknown field(s) ${bad.join(", ") || "(none given)"}. Vars: ${VAR_FIELDS.join(",")}; HTTP: ${HTTP_FIELDS.join(",")}; or "all".`, {
      code: "INVALID_VALUE",
    });
  }
  return list;
}

function varRows(page: HydratedPage, fields: string[] | null): { userDefined: Row[]; derived: Row[] } {
  const all = fields?.[0] === "all";
  const user = page.variables.map((v): Row => {
    const full: Row = { name: v.name, type: v.type, initialValue: v.initialValue };
    if (fields) return all ? full : pickFields(full, ["name", ...fields]);
    const row = pickFields(full, DEFAULT_VAR_FIELDS);
    const json = v.initialValue === undefined ? "" : JSON.stringify(v.initialValue);
    if (typeof v.initialValue !== "number" && typeof v.initialValue !== "boolean" && json.length > SHORT_VALUE) {
      delete row.initialValue;
      row.initialValueBytes = json.length;
    }
    return row;
  });
  const derived = page.derived.map((d): Row => {
    const full: Row = { name: d.name, from: d.from, spec: d.spec, filterFn: d.filterFn, sideEffect: d.sideEffect };
    if (fields) return all ? full : pickFields(full, ["name", ...fields]);
    return pickFields(full, DEFAULT_DERIVED_FIELDS);
  });
  return { userDefined: user, derived };
}

function httpRows(page: HydratedPage, fields: string[] | null): Row[] {
  return page.httpRequests.map((c): Row => {
    const full: Row = {
      index: c.index,
      label: c.label.trim(),
      callId: c.callId,
      adId: c.adId,
      serviceUuid: c.serviceUuid,
      method: c.method,
      triggers: c.triggers,
      outputs: c.successMappings.map((m) => m.variable),
      inProgressVar: c.inProgressVar,
      eventMeta: c.hasEventMeta ? (c.eventMetaEmpty ? "empty" : "set") : null,
    };
    if (fields?.[0] === "all") return full;
    return pickFields(full, fields ? ["index", ...fields] : DEFAULT_HTTP_FIELDS);
  });
}

/** `--components`: one line per node, one space of indent per level. */
function componentLines(node: ComponentTreeNode, depth = 0, out: string[] = []): string[] {
  out.push(`${" ".repeat(depth)}${node.name}${node.id ? `#${node.id}` : ""}${node.isSymbol ? " [sym]" : ""}${node.hasEvents ? " [ev]" : ""}`);
  for (const c of node.children) componentLines(c, depth + 1, out);
  return out;
}

/** `--tree`: the human tree line, one space of indent per level. */
function treeLine(e: TreeLineEntry): string {
  const badges = e.badge + (e.loop ? " [loop]" : "") + (e.hasEvents ? " [events]" : "");
  const summary = e.summary && e.summary !== e.tagName ? ` — ${e.summary}` : "";
  return `${" ".repeat(e.depth)}${badges} ${e.tagName}#${e.nodeId}${summary}`;
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

interface ShowSummary {
  name: string;
  entityType: "PAGE" | "COMPONENT";
  resolvedId: string;
  status: string | null;
  draftId: string | null;
  publishedId: string | null;
  versionId: string | number | null;
  // The overview fields below are only on a bare `pd show` (and --full/--raw):
  // with a section flag the summary is just the identity above.
  inputKind?: InputKind;
  editUrl?: string | null;
  configSizeBytes?: number;
  topLevelKeys?: string[];
  userDefinedVarCount?: number;
  derivedVarCount?: number;
  httpCallCount?: number;
  directChildComponents?: Array<{ name: string }>;
  adMethodIds?: string[];
}

interface ShowData {
  source: "cache" | "stale" | "fresh";
  summary: ShowSummary;
  vars?: { userDefined: Row[]; derived: Row[] };
  http?: Row[];
  /** One line per node: `<indent>name#id [sym] [ev]`. */
  components?: string[];
  find?: { query: string; total: number; matches: FoundNode[] };
  varDetail?: VarDetail | null;
  httpDetail?: HttpCallDetail | null;
  recursive?: {
    treeLines: string[];
    uniqueAdMethodIds: string[];
    /** Components that could not be fetched/resolved during the walk. */
    errors: AnalyzeError[];
  };
  raw?: {
    configurationRaw: string;
    sourceFields: Record<string, unknown>;
  };
  // Phase-7 additions
  /** One line per node: `<indent>[BADGE] [loop] [events] tag#id — summary`. */
  tree?: string[];
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

/**
 * Draft / published ids from the fetched row: the API returns ONE entity
 * (draft OR published) plus `referenceId` pointing at the other version.
 */
function extractMetadata(source: RawPageResponse, fallbackId: string) {
  const status = typeof source.status === "string" ? source.status.toUpperCase() : null;
  const ownId = strOrNull(source.id) ?? fallbackId;
  const refId = strOrNull(source.referenceId);
  const isPublished = status === "PUBLISHED";
  return {
    status,
    draftId: isPublished ? refId : ownId,
    publishedId: isPublished ? ownId : refId,
    versionId: typeof source.versionId === "number" ? source.versionId : null,
  };
}

function truncate(value: unknown, maxLen = 80): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (!str) return "(null)";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}


// --- Command ---

export const args = defineArgs({
  command: "wi-impl pd show",
  positionals: [
    {
      name: "input",
      required: true,
      missingCode: "MISSING_INPUT",
      missingMessage: "Missing argument. Provide a page URL, PD designer URL, page/component ID, or component name.",
    },
  ],
  flags: {
    vars: { type: "boolean" },
    http: { type: "boolean" },
    components: { type: "boolean" },
    full: { type: "boolean" },
    ...PD_FORCE_FLAG,
    raw: { type: "boolean" },
    recursive: { type: "boolean", alias: ["-r"] },
    // A value flag with no value is MISSING_VALUE (was silently ignored).
    "var-detail": { type: "string" },
    "http-detail": { type: "number", integer: true, min: 1 },
    tree: { type: "boolean" },
    node: { type: "string" },
    "var-graph": { type: "boolean" },
    open: { type: "boolean", alias: ["-o"] },
    find: { type: "string" },
    fields: { type: "string" },
  },
});

const command: CommandModule<ShowArgs, ShowData> = {
  parseArgs(argv) {
    const { positionals, flags: f } = args.parse(argv);
    const flags: ShowArgs["flags"] = {
      vars: f.vars,
      http: f.http,
      components: f.components,
      full: f.full,
      force: f.force,
      raw: f.raw,
      recursive: f.recursive,
      varDetail: f.varDetail ?? null,
      httpDetail: f.httpDetail ?? -1,
      tree: f.tree,
      node: f.node ?? null,
      varGraph: f.varGraph,
      open: f.open,
      find: f.find ?? null,
      fields: parseFields(f.fields),
    };
    return { input: positionals.input, flags };
  },

  async execute({ input, flags }, context) {
    const resolved = await resolveInput(input, flags.force);
    const { entityType, resolvedId, response, inputKind, source } = resolved;
    const configStr = response.configuration;
    if (typeof configStr !== "string") {
      // Previously crashed later with a raw TypeError (Buffer.byteLength(undefined)).
      throw new CliError(`${entityType === "PAGE" ? "Page" : "Component"} ${resolvedId} has no configuration.`, {
        code: "PD_CONFIG_MISSING",
        details: { resolvedId, entityType },
      });
    }

    if (source === "stale") {
      // Serve stale data now; refresh the cache in a detached background process.
      context.warn("Using stale cached config — refreshing in background.");
      triggerDetachedRefresh(pdCacheDir(), resolvedId);
    } else if (source === "cache") {
      context.warn("Using cached config. Use --force for refresh.");
    }

    const page: HydratedPage = parsePage(response);
    const configurationParsed = page.rawConfiguration;
    const resolvedName = response.name || resolvedId;
    const vars = variablesView(page);
    const httpCalls = httpSummary(page);

    const rawMetadata = extractMetadata(response, resolvedId);
    // Build the editable-draft URL. PD pages route by draft id; symbols/
    // components route by name (the UI resolves the name to the draft).
    const editUrl = (() => {
      const base = Config.cleanBaseUrl;
      if (entityType === "COMPONENT") {
        return `${base}/ui-designer/symbol/${encodeURIComponent(resolvedName)}`;
      }
      return `${base}/ui-designer/page/${rawMetadata.draftId ?? resolvedId}`;
    })();

    const includeVars = flags.vars || flags.full;
    const includeHttp = flags.http || flags.full;
    const includeComponents = flags.components || flags.full;

    const sectionMode =
      !flags.full && !flags.raw &&
      (flags.vars || flags.http || flags.components || flags.tree || !!flags.find || !!flags.node ||
        !!flags.varDetail || flags.httpDetail >= 1 || flags.varGraph);
    const identity: ShowSummary = {
      name: resolvedName,
      entityType,
      resolvedId,
      status: rawMetadata.status,
      draftId: rawMetadata.draftId,
      publishedId: rawMetadata.publishedId,
      versionId: rawMetadata.versionId,
    };
    const data: ShowData = {
      source,
      summary: sectionMode ? identity : {
        ...identity,
        inputKind,
        editUrl,
        configSizeBytes: Buffer.byteLength(configStr, "utf-8"),
        topLevelKeys:
          isObj(configurationParsed) ? Object.keys(configurationParsed) : [],
        userDefinedVarCount: vars.userDefined.length,
        derivedVarCount: vars.derived.length,
        httpCallCount: httpCalls.length,
        directChildComponents: childComponentNames(page).map((name) => ({ name })),
        adMethodIds: adIdsOf(page),
      },
    };

    if (includeVars) data.vars = varRows(page, flags.fields);
    if (includeHttp) data.http = httpRows(page, flags.fields);
    if (includeComponents) data.components = componentLines(componentTree(page.layout));
    if (flags.find) {
      const matches = findNodes(page, flags.find);
      data.find = { query: flags.find, total: matches.length, matches };
    }

    if (flags.varDetail) {
      data.varDetail = varDetail(page, flags.varDetail);
      if (!data.varDetail) {
        throw new CliError(`Variable "${flags.varDetail}" not found.`, { code: "VAR_NOT_FOUND" });
      }
    }

    if (flags.httpDetail >= 1) {
      data.httpDetail = httpDetail(page, flags.httpDetail);
      if (!data.httpDetail) {
        throw new CliError(`HTTP call #${flags.httpDetail} not found. Valid range: 1-${httpCalls.length}`, {
          code: "HTTP_NOT_FOUND",
        });
      }
    }

    if (flags.recursive) {
      const errors: AnalyzeError[] = [];
      const tree = await analyzeItem(resolvedId, resolvedName, new Set<string>(), errors, cacheDeps(flags.force), resolved.response);
      for (const e of errors) context.warn(`⚠ recursive: ${e.name}${e.id ? ` (${e.id})` : ""}: ${e.message}`);
      data.recursive = {
        treeLines: formatTreeLines(tree),
        uniqueAdMethodIds: collectAllAdIds([tree]),
        errors,
      };
    }

    if (flags.raw) {
      const safeSourceFields = Object.fromEntries(
        Object.entries(response).filter(([key]) => key !== "configuration")
      );
      data.raw = {
        configurationRaw: configStr,
        sourceFields: safeSourceFields,
      };
    }

    // ----- Phase-7 additions: tree / node / var-graph / parseWarnings --------
    const needHydrated = flags.tree || !!flags.node || flags.varGraph || flags.full;
    if (needHydrated) {
      if (page.parseWarnings.length > 0) data.parseWarnings = page.parseWarnings;

      if (flags.tree || flags.full) {
        data.tree = buildTreeLines(page.layout).map(treeLine);
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
        ...(s.configSizeBytes === undefined ? [] : [
          ["Edit URL", s.editUrl ?? "N/A"],
          ["Config Size", `${s.configSizeBytes} bytes`],
          ["Variables", `${s.userDefinedVarCount} user-defined, ${s.derivedVarCount} derived`],
          ["HTTP Calls", s.httpCallCount ?? 0],
          ["Child Components", s.directChildComponents?.length ?? 0],
          ["AD Methods", s.adMethodIds?.length ?? 0],
        ]),
        ["Source", data.source === "stale" ? "stale (refreshing…)" : data.source],
      ]
    );

    const children = s.directChildComponents ?? [];
    if (children.length > 0) {
      ui.section("Direct Child Components");
      ui.table(["#", "Component Name"], children.map((c, idx) => [idx + 1, c.name]));
    }

    const adIds = s.adMethodIds ?? [];
    if (adIds.length > 0) {
      ui.section("Direct AD Method IDs");
      ui.table(["#", "Method ID"], adIds.map((id, idx) => [idx + 1, id]));
    }

    const cell = (v: unknown, max = 60) => (v === undefined ? "—" : Array.isArray(v) ? v.join(", ") || "—" : truncate(v, max));

    // --vars (rows carry only the requested fields; see --fields)
    if (data.vars) {
      ui.section("User-Defined Variables");
      if (data.vars.userDefined.length === 0) {
        ui.text("None.");
      } else {
        const cols = [...new Set(data.vars.userDefined.flatMap((r) => Object.keys(r)))];
        ui.table(["#", ...cols], data.vars.userDefined.map((r, i) => [i + 1, ...cols.map((c) => cell(r[c]))]));
      }

      ui.section("Derived Variables");
      if (data.vars.derived.length === 0) {
        ui.text("None.");
      } else {
        const cols = [...new Set(data.vars.derived.flatMap((r) => Object.keys(r)))];
        ui.table(["#", ...cols], data.vars.derived.map((r, i) => [i + 1, ...cols.map((c) => cell(r[c]))]));
      }
    }

    // --http
    if (data.http) {
      ui.section("HTTP Service Calls");
      if (data.http.length === 0) {
        ui.text("None.");
      } else {
        const cols = [...new Set(data.http.flatMap((r) => Object.keys(r)))];
        ui.table(cols, data.http.map((r) => cols.map((c) => cell(r[c], 40))));
      }
    }

    // --find
    if (data.find) {
      ui.section(`Nodes matching "${data.find.query}" (${data.find.total})`);
      if (data.find.total === 0) ui.text("None.");
      else {
        ui.table(
          ["Id", "Component", "Label", "Path"],
          data.find.matches.map((m) => [m.id, m.component, m.label ?? "", m.path]),
        );
        ui.info('Edit by id: {"nodes":{"update":[{"id":"<id>","props":{…}}]}} in `wi-impl pd save --overlay`.');
      }
    }

    // --components
    if (data.components) {
      ui.section("Component Tree");
      for (const line of data.components) ui.text(line);
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
      for (const line of data.tree) ui.text(line);
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
      !data.vars && !data.http && !data.components && !data.varDetail && !data.find &&
      !data.httpDetail && !data.tree && !data.nodeDetail && !data.varGraph
    ) {
      ui.info("Use --vars, --http, --components, --tree, --find <text|id|component>, --var-graph, --node <id>, or --full for more detail.");
    }
  },
};

export default command;
