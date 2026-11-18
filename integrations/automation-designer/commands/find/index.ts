import { CliError, type CommandModule, defineSubcommands, type FieldSelection, FINDER_INDEX_TTL_MS, type FlagsSpec, lifecycle, ok, openUrlInBrowser, parseFieldList, projectRow } from "@belzabar/core";
import { abbreviate } from "../../lib/compact";
import { adApi } from "../../lib/api/index";
import { spawn } from "node:child_process";
import {
  type MethodFinderIndex,
  METHOD_FINDER_SCHEMA,
  describeSearch,
  listMethodFinderCategories,
  loadDirtyMethods,
  loadOrBuildMethodFinderIndex,
  normalizeMethodRecord,
  searchMethodIndex,
  type MethodFinderMethod,
  type MethodFinderCategory,
  type MethodFinderMatch,
} from "../../lib/method-finder";

interface FindArgs {
  mode: "browse" | "search" | "pick" | "describe" | "exact";
  query?: string;
  /** `--exact`: the method names (one per argument). */
  names?: string[];
  refresh: boolean;
  limit: number;
  /** `--limit` was given (a `--category` method listing is uncapped otherwise). */
  limitExplicit?: boolean;
  open: boolean;
  raw: boolean;
  /** `--category <prefix>`: only categories whose name starts with it. */
  category?: string;
  fields?: FieldSelection;
}

type Row = Record<string, unknown>;

/** Index freshness (compact — no ttl/expiry arithmetic for the caller to do). */
interface CacheMeta {
  source: "cache" | "fresh";
  generatedAt: number;
  ageMinutes: number;
  categoryCount: number;
  methodCount: number;
  skippedCategoryCount?: number;
}

interface FindBrowseData {
  mode: "browse";
  cache: CacheMeta;
  categories: Row[];
  /** With --category: the methods in the matching categories (by name, capped at --limit). */
  totalMethods?: number;
  methods?: Row[];
  raw?: RawIndexView;
}

interface FindSearchData {
  mode: "search";
  query: string;
  cache: CacheMeta;
  totalMatches: number;
  matches: Row[];
  raw?: RawIndexView;
}

interface FindDescribeData {
  mode: "describe";
  query: string;
  cache: CacheMeta;
  totalMatches: number;
  matches: Row[];
}

interface FindPickData {
  mode: "pick";
  query?: string;
  cache: CacheMeta;
  status: "selected" | "cancelled";
  selected: MethodFinderMethod | null;
  opened: boolean;
  raw?: RawIndexView;
}

/** `--exact`: one row per method (draft + published pair) whose name or alias is exactly the asked name. */
interface ExactRow {
  name: string;
  category: string;
  draftUuid?: string;
  publishedUuid?: string;
  /** The published automation-API uuid callers reference (absent for a never-published method). */
  apiUuid?: string;
  apiUuidNote?: string;
  draftVersion?: number;
  publishedVersion?: number;
  versionAgeMinutes?: number;
}

interface FindExactData {
  mode: "exact";
  cache: CacheMeta;
  results: Array<{ name: string; found: boolean; methods: ExactRow[] }>;
}

type FindData = FindBrowseData | FindSearchData | FindDescribeData | FindPickData | FindExactData;

/** D28: why a method row has no apiUuid. */
const NO_API_ID_YET = "never published: no API id callers can use until first publish";
const NO_API_ID_INDEXED = "no API id in the index (try --refresh)";

/** Per-row freshness (D8): the index age, 0 for rows re-read because wi-impl wrote them. */
interface RowContext {
  ageMinutes: number;
  refreshed: Set<string>;
}

// ── Compact rows ──────────────────────────────────────────────────────
// Default rows carry what picks the next command; `--fields a,b` picks
// fields, `--fields all` returns the full index records. Empty values are omitted.

export const METHOD_FIELDS = [
  "type", "name", "alias", "category", "state", "uuid", "referenceId", "apiUuid", "summary", "description",
  "version", "categoryUuid", "createdOn", "updatedOn", "url", "score", "matched",
] as const;
const DEFAULT_METHOD_FIELDS = ["type", "name", "alias", "category", "state", "uuid", "referenceId", "apiUuid", "summary", "score"];
const DEFAULT_DESCRIBE_FIELDS = ["name", "category", "state", "uuid", "referenceId", "apiUuid", "summary", "matched", "score"];
export const CATEGORY_FIELDS = ["type", "name", "id", "uuid", "systemUuid", "label", "aliases", "methods", "score"] as const;
const DEFAULT_CATEGORY_FIELDS = ["type", "name", "id", "uuid", "methods", "score"];

function methodRow(m: MethodFinderMethod & { score?: number; matched?: string[] }, sel: FieldSelection, defaults: string[], typed: boolean, ctx?: RowContext): Row {
  const full: Row = {
    ...(typed ? { type: "method" } : {}),
    name: m.methodName,
    alias: m.aliasName && m.aliasName !== m.methodName ? m.aliasName : undefined,
    category: m.categoryName,
    state: m.state,
    uuid: m.uuid,
    referenceId: m.referenceId,
    apiUuid: m.automationApiUuid,
    summary: sel.mode === "default" && m.summary ? abbreviate(m.summary, 120, "--fields summary for all") : m.summary,
    description: m.description,
    version: m.version,
    categoryUuid: m.categoryUuid,
    createdOn: m.createdOn,
    updatedOn: m.updatedOn,
    url: m.url,
    score: m.score,
    matched: m.matched,
  };
  const row = projectRow(full, sel, defaults);
  // D37: `type` says what the row is; --fields never drops it.
  const out: Row = typed && !("type" in row) ? { type: "method", ...row } : row;
  const wantsApi = sel.mode === "all" || (sel.mode === "pick" ? sel.fields.includes("apiUuid") : defaults.includes("apiUuid"));
  // A draft-only method's own api uuid does not resolve for callers (child-info / save resolve published APIs).
  if (wantsApi && m.state === "DRAFT" && !m.referenceId) out.apiUuidNote = NO_API_ID_YET;
  else if (wantsApi && !m.automationApiUuid) out.apiUuidNote = NO_API_ID_INDEXED;
  // D8: the age of the version shown, next to it.
  if ("version" in out && ctx) out.versionAgeMinutes = ctx.refreshed.has(m.uuid.toLowerCase()) ? 0 : ctx.ageMinutes;
  return out;
}

function categoryRow(c: MethodFinderCategory & { score?: number }, sel: FieldSelection, typed: boolean): Row {
  const full: Row = {
    ...(typed ? { type: "category" } : {}),
    name: c.name,
    id: c.chainCategoryId,
    uuid: c.uuid,
    systemUuid: c.systemUuid,
    label: c.label !== c.name ? c.label : undefined,
    aliases: c.aliasNames.filter((a) => a !== c.name),
    methods: c.methodCount,
    score: c.score,
  };
  const row = projectRow(full, sel, DEFAULT_CATEGORY_FIELDS);
  return typed && !("type" in row) ? { type: "category", ...row } : row;
}

/**
 * D8: rows for methods wi-impl wrote (saved, published, deleted…) after the
 * index was built are re-read (one V1 GET each) so their version / state /
 * referenceId / apiUuid are current. Returns the uuids it refreshed.
 */
async function freshenWritten(index: MethodFinderIndex, methods: MethodFinderMethod[]): Promise<Set<string>> {
  const refreshed = new Set<string>();
  const dirty = await loadDirtyMethods(index).catch(() => new Map<string, number>());
  if (dirty.size === 0) return refreshed;
  await Promise.all(
    methods.map(async (m) => {
      const id = m.uuid.toLowerCase();
      if (!dirty.has(id) && !(m.referenceId && dirty.has(m.referenceId.toLowerCase()))) return;
      const raw = await adApi.fetchRawMethod(m.uuid, "v1").catch(() => null);
      const fresh = raw ? normalizeMethodRecord(raw, { uuid: m.categoryUuid, name: m.categoryName }) : null;
      if (!fresh) return;
      m.version = fresh.version;
      m.state = fresh.state;
      m.referenceId = fresh.referenceId;
      if (fresh.automationApiUuid) m.automationApiUuid = fresh.automationApiUuid;
      if (fresh.updatedOn) m.updatedOn = fresh.updatedOn;
      refreshed.add(id);
    }),
  );
  return refreshed;
}

/** D9: the draft + published pair(s) named exactly `name` (method name or alias). */
export function exactRows(methods: MethodFinderMethod[], name: string, ctx?: RowContext): ExactRow[] {
  const hits = methods.filter((m) => m.methodName === name || m.aliasName === name);
  const used = new Set<MethodFinderMethod>();
  const rows: ExactRow[] = [];
  const byUuid = new Map(hits.map((m) => [m.uuid.toLowerCase(), m]));
  for (const m of hits) {
    if (used.has(m)) continue;
    used.add(m);
    const other = m.referenceId ? byUuid.get(m.referenceId.toLowerCase()) : undefined;
    if (other) used.add(other);
    const pub = m.state === "PUBLISHED" ? m : other?.state === "PUBLISHED" ? other : undefined;
    const draft = m.state !== "PUBLISHED" ? m : other && other.state !== "PUBLISHED" ? other : undefined;
    // Callers reference the published API; a draft's own api uuid does not resolve for them.
    const apiUuid = pub?.automationApiUuid;
    const row: ExactRow = {
      name: m.methodName,
      category: m.categoryName,
      draftUuid: draft?.uuid ?? (pub?.referenceId || undefined),
      publishedUuid: pub?.uuid ?? (draft?.referenceId || undefined),
      apiUuid,
      draftVersion: draft?.version,
      publishedVersion: pub?.version,
    };
    if (!apiUuid) row.apiUuidNote = pub || draft?.referenceId ? NO_API_ID_INDEXED : NO_API_ID_YET;
    if (ctx) row.versionAgeMinutes = [draft, pub].some((x) => x && ctx.refreshed.has(x.uuid.toLowerCase())) ? 0 : ctx.ageMinutes;
    rows.push(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== "")) as ExactRow);
  }
  return rows.sort((a, b) => a.category.localeCompare(b.category));
}

/** `--raw` payload: the index capped at `--limit` methods and categories (was 1.6 MB). */
interface RawIndexView {
  index: MethodFinderIndex;
  truncated: { methods: number; categories: number };
}

export function rawIndex(index: MethodFinderIndex, limit: number): RawIndexView {
  return {
    index: { ...index, methods: index.methods.slice(0, limit), categories: index.categories.slice(0, limit) },
    truncated: {
      methods: Math.max(0, index.methods.length - limit),
      categories: Math.max(0, index.categories.length - limit),
    },
  };
}

const FIND_FLAGS = {
  refresh: { type: "boolean" },
  raw: { type: "boolean" },
  open: { type: "boolean" },
  limit: { type: "number", integer: true, min: 1, max: 10000 },
  describe: { type: "boolean" },
  exact: { type: "boolean" },
  category: { type: "string" },
  fields: { type: "string" },
} as const satisfies FlagsSpec;

const SUBCOMMANDS = new Set(["list", "pick", "search"]);
/** Flags that consume the next argv token. */
const VALUE_FLAGS = new Set(Object.entries(FIND_FLAGS).filter(([, f]) => f.type !== "boolean").map(([k]) => `--${k}`));

/**
 * Flags may come before the subcommand (`ad find --refresh list`), but
 * defineSubcommands reads the subcommand from argv[0]: move the first bare
 * subcommand name to the front.
 */
export function subcommandFirst(argv: readonly string[]): string[] {
  if (argv.length === 0 || !argv[0]!.startsWith("-")) return [...argv];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    if (SUBCOMMANDS.has(a)) return [a, ...argv.slice(0, i), ...argv.slice(i + 1)];
    break;
  }
  return [...argv];
}

export const args = defineSubcommands(
  {
    list: { flags: FIND_FLAGS, codes: { UNEXPECTED_ARGUMENT: "LIST_DOES_NOT_ACCEPT_QUERY" } },
    pick: { positionals: [{ name: "query", variadic: true }], flags: FIND_FLAGS },
    search: { positionals: [{ name: "query", variadic: true }], flags: FIND_FLAGS },
  },
  { command: "wi-impl ad find", default: "search" },
);

const command: CommandModule<FindArgs, FindData> = {
  parseArgs(argv) {
    const parsed = args.parse(subcommandFirst(argv));
    const { refresh, raw, open, describe, category, exact } = parsed.flags;
    const query = parsed.subcommand === "list" ? "" : parsed.positionals.query.join(" ").trim();
    if (describe && (parsed.subcommand !== "search" || !query)) {
      throw new CliError("--describe needs search words: `wi-impl ad find --describe <text>`.", { code: "MISSING_QUERY" });
    }
    let names: string[] | undefined;
    if (exact) {
      if (parsed.subcommand !== "search" || describe) {
        throw new CliError("--exact takes method names only: `wi-impl ad find --exact <name> [<name>…]`.", { code: "INVALID_ARGUMENT" });
      }
      names = [...new Set(parsed.positionals.query.flatMap((n) => n.split(",")).map((n) => n.trim()).filter(Boolean))];
      if (names.length === 0) throw new CliError("--exact needs at least one method name.", { code: "MISSING_QUERY" });
    }
    const mode: FindArgs["mode"] =
      parsed.subcommand === "pick" ? "pick" : exact ? "exact" : describe ? "describe" : query ? "search" : "browse";
    // --category lists methods: their fields are accepted too (D10).
    const known: readonly string[] = mode === "browse" && !category ? CATEGORY_FIELDS : [...new Set<string>([...METHOD_FIELDS, ...CATEGORY_FIELDS])];
    const fields = parseFieldList(parsed.flags.fields, known);
    const limit = parsed.flags.limit ?? 20;
    return {
      mode, query: query || undefined, names, refresh, limit, limitExplicit: parsed.flags.limit !== undefined,
      open, raw, category: category?.trim() || undefined, fields,
    };
  },
  async execute({ mode, query, names, refresh, limit, limitExplicit, open, raw, category, fields }, context) {
    const sel: FieldSelection = fields ?? { mode: "default" };
    if (open && mode !== "pick") {
      throw new CliError("--open is only supported with `wi-impl ad find pick`.", {
        code: "OPEN_REQUIRES_PICK",
      });
    }

    // fzf needs a terminal; fail cleanly before any work when there is none.
    if (mode === "pick" && context.outputMode !== "llm" && !(process.stdin.isTTY && process.stderr.isTTY)) {
      throw new CliError("Interactive picker needs a terminal (stdin/stderr are not a TTY). Use `wi-impl ad find <query>`.", {
        code: "INTERACTIVE_NOT_SUPPORTED",
      });
    }

    // a rebuild walks every category (minutes on big envs) — report progress
    // on stderr (human mode; lifecycle.notice is silent with --llm).
    const { index, source } = await loadOrBuildMethodFinderIndex({
      refresh,
      // --describe needs summaries/descriptions (index schema 2); older caches are rebuilt.
      minSchema: mode === "describe" ? METHOD_FINDER_SCHEMA : 1,
      onProgress: ({ done, total, category }) => {
        if (done === 1 || done === total || done % 10 === 0) {
          lifecycle.notice(`Indexing AD methods: ${done}/${total} categories (${category})`);
        }
      },
    });
    const ageMs = Math.max(0, Date.now() - index.generatedAt);

    if (source === "cache") {
      context.warn("Using cached method index. Use --refresh to fetch latest data.");
    }

    const cacheMeta: CacheMeta = {
      source,
      generatedAt: index.generatedAt,
      ageMinutes: Math.round(ageMs / 60000),
      categoryCount: index.categoryCount,
      methodCount: index.methodCount,
    };
    if (index.skippedCategories.length > 0) {
      cacheMeta.skippedCategoryCount = index.skippedCategories.length;
      context.warn(
        `${index.skippedCategories.length} categories could not be fully indexed due to API access or fetch errors.`
      );
    }
    if (ageMs > FINDER_INDEX_TTL_MS) context.warn("Method index is older than its TTL — use --refresh.");

    // --category: a name prefix, a chain-category id or a category uuid.
    const catRef = category?.toLowerCase();
    const matchingCategories = new Set(
      index.categories
        .filter((c) => !catRef || c.name.toLowerCase().startsWith(catRef) || String(c.chainCategoryId ?? "") === catRef || c.uuid.toLowerCase() === catRef)
        .map((c) => c.uuid),
    );
    const inCategory = (uuid: string) => !catRef || matchingCategories.has(uuid);
    const scoped = catRef
      ? { ...index, methods: index.methods.filter((m) => inCategory(m.categoryUuid)), categories: index.categories.filter((c) => inCategory(c.uuid)) }
      : index;

    if (mode === "exact") {
      const pool = (names ?? []).flatMap((n) => scoped.methods.filter((m) => m.methodName === n || m.aliasName === n));
      const ctx: RowContext = { ageMinutes: cacheMeta.ageMinutes, refreshed: await freshenWritten(index, pool) };
      const results = (names ?? []).map((n) => {
        const methods = exactRows(scoped.methods, n, ctx);
        return { name: n, found: methods.length > 0, methods };
      });
      const missing = results.filter((r) => !r.found).map((r) => r.name);
      if (missing.length) context.warn(`No method named exactly ${missing.join(", ")}${source === "cache" ? " in the cached index (a method created outside wi-impl since needs --refresh)" : ""}.`);
      return ok<FindData>({ mode: "exact", cache: cacheMeta, results });
    }

    if (mode === "browse") {
      const categories = listMethodFinderCategories(scoped).map((c) => categoryRow(c, sel, false));

      const data: FindBrowseData = {
        mode: "browse",
        cache: cacheMeta,
        categories,
      };
      if (catRef) {
        // `find --category X` returned only a count; list the methods.
        const methods = [...scoped.methods].sort((a, b) => a.methodName.localeCompare(b.methodName) || a.state.localeCompare(b.state));
        data.totalMethods = methods.length;
        // Every method unless --limit is given (D10).
        const listed = limitExplicit ? methods.slice(0, limit) : methods;
        const ctx: RowContext = { ageMinutes: cacheMeta.ageMinutes, refreshed: await freshenWritten(index, listed) };
        data.methods = listed.map((m) => methodRow(m, sel, DEFAULT_METHOD_FIELDS.filter((f) => f !== "type" && f !== "score"), false, ctx));
        if (categories.length === 0) context.warn(`No category matches '${category}' (name prefix, id or uuid).`);
      }

      if (raw) {
        data.raw = rawIndex(scoped, limit);
      }

      return ok(data);
    }

    if (mode === "pick") {
      if (context.outputMode === "llm") {
        throw new CliError("Interactive picker is not supported with --llm.", {
          code: "INTERACTIVE_NOT_SUPPORTED",
        });
      }

      const selected = await runFzfPicker(scoped.methods, query);
      const data: FindPickData = {
        mode: "pick",
        query,
        cache: cacheMeta,
        status: selected ? "selected" : "cancelled",
        selected,
        opened: false,
      };

      if (open && selected) {
        await openUrlInBrowser(selected.url);
        data.opened = true;
      }

      if (raw) {
        data.raw = rawIndex(scoped, limit);
      }

      return ok(data);
    }

    const searchQuery = query ?? "";
    if (mode === "describe") {
      // totalMatches = every match; `matches` is capped at --limit.
      const all = describeSearch(scoped, searchQuery, Number.MAX_SAFE_INTEGER);
      const found = all.slice(0, Math.max(1, limit));
      if (found.length === 0) context.warn("No method summary/description matches found.");
      const ctx: RowContext = { ageMinutes: cacheMeta.ageMinutes, refreshed: await freshenWritten(index, found) };
      const data: FindDescribeData = {
        mode: "describe",
        query: searchQuery,
        cache: cacheMeta,
        totalMatches: all.length,
        matches: found.map((m) => methodRow(m, sel, DEFAULT_DESCRIBE_FIELDS, false, ctx)),
      };
      return ok(data);
    }

    const allMatches: MethodFinderMatch[] = searchMethodIndex(scoped, searchQuery, Number.MAX_SAFE_INTEGER);
    const matches = allMatches.slice(0, Math.max(1, limit));
    if (matches.length === 0) {
      context.warn("No method or category matches found.");
    }
    const ctx: RowContext = {
      ageMinutes: cacheMeta.ageMinutes,
      refreshed: await freshenWritten(index, matches.filter((m): m is Extract<MethodFinderMatch, { type: "method" }> => m.type === "method")),
    };

    const data: FindSearchData = {
      mode: "search",
      query: searchQuery,
      cache: cacheMeta,
      totalMatches: allMatches.length,
      matches: matches.map((m) => (m.type === "method" ? methodRow(m, sel, DEFAULT_METHOD_FIELDS, true, ctx) : categoryRow(m, sel, true))),
    };

    if (raw) {
      data.raw = rawIndex(scoped, limit);
    }

    return ok(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;

    const data = envelope.data as FindData;

    ui.success(
      `Indexed ${data.cache.methodCount} methods across ${data.cache.categoryCount} categories (${data.cache.source}, ${data.cache.ageMinutes} min old).`
    );

    if (data.cache.skippedCategoryCount) {
      ui.warn(
        `${data.cache.skippedCategoryCount} categories could not be fully indexed due to API access or fetch errors.`
      );
    }

    if (data.mode === "exact") {
      const rows = data.results.flatMap((r) =>
        r.methods.length
          ? r.methods.map((m) => [r.name, m.category, m.draftUuid ?? "", m.publishedUuid ?? "", m.apiUuid ?? m.apiUuidNote ?? ""])
          : [[r.name, "(not found)", "", "", ""]],
      );
      ui.table(["Name", "Category", "Draft uuid", "Published uuid", "API uuid"], rows);
      return;
    }

    if (data.mode === "pick") {
      if (!data.selected) {
        ui.info("No method selected.");
        return;
      }

      ui.table(
        ["Property", "Value"],
        [
          ["Method Name", data.selected.methodName],
          ["Alias", data.selected.aliasName],
          ["UUID", data.selected.uuid],
          ["Reference ID", data.selected.referenceId],
          ["State", data.selected.state],
          ["Category", data.selected.categoryName],
          ["URL", data.selected.url],
        ]
      );
      if (data.opened) {
        ui.success("Opened selected method in browser.");
      }
      ui.text(`Tip: run 'wi-impl ad show ${data.selected.uuid}' for full details.`);
      return;
    }

    const rows = data.mode === "browse" ? data.categories : data.matches;
    if (rows.length === 0) {
      ui.info(data.mode === "browse" ? "No categories were found." : `No matches found for '${data.query}'.`);
      return;
    }
    const columns: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
    const cell = (v: unknown) => (v === undefined ? "" : Array.isArray(v) ? v.join(", ") : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
    ui.table(["#", ...columns], rows.map((r, i) => [i + 1, ...columns.map((c) => cell(r[c]))]));
    if (data.mode === "browse" && data.methods) {
      ui.section(`Methods (${data.methods.length} of ${data.totalMethods})`);
      const mcols: string[] = [];
      for (const r of data.methods) for (const k of Object.keys(r)) if (!mcols.includes(k)) mcols.push(k);
      if (data.methods.length) ui.table(["#", ...mcols], data.methods.map((r, i) => [i + 1, ...mcols.map((c) => cell(r[c]))]));
    }
    if (data.mode !== "browse" || data.methods) ui.text("Tip: run 'wi-impl ad show <uuid> --compact' to inspect a matched method.");
  },
};

export default command;

function runFzfPicker(methods: MethodFinderMethod[], query?: string): Promise<MethodFinderMethod | null> {
  if (methods.length === 0) return Promise.resolve(null);

  const sorted = [...methods].sort((a, b) => {
    const name = a.methodName.localeCompare(b.methodName);
    if (name !== 0) return name;
    return a.uuid.localeCompare(b.uuid);
  });

  const rows = sorted.map((method) =>
    [
      method.methodName,
      method.aliasName || "-",
      method.state,
      method.categoryName,
      method.uuid,
      method.referenceId || "-",
    ].join("\t")
  );

  const args = [
    "--delimiter",
    "\t",
    "--with-nth",
    "1,2,3,4",
    "--prompt",
    "Method> ",
    "--height",
    "85%",
    "--layout",
    "reverse",
    "--border",
    "--cycle",
  ];

  if (query) {
    args.push("--query", query);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("fzf", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let missingBinary = false;

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        missingBinary = true;
      } else {
        reject(error);
      }
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code: number | null) => {
      if (missingBinary) {
        reject(
          new CliError(
            "fzf is not installed. Install fzf or use `wi-impl ad find <query>` for non-interactive search.",
            { code: "FZF_NOT_INSTALLED" }
          )
        );
        return;
      }

      if (code === 130 || code === 1) {
        resolve(null);
        return;
      }

      if (code !== 0) {
        reject(
          new CliError(`fzf failed${stderr ? `: ${stderr.trim()}` : "."}`, {
            code: "FZF_FAILED",
          })
        );
        return;
      }

      const line = stdout.trim();
      if (!line) {
        resolve(null);
        return;
      }

      const parts = line.split("\t");
      const selectedUuid = parts[4]?.trim();
      if (!selectedUuid) {
        resolve(null);
        return;
      }

      const selected = sorted.find((method) => method.uuid === selectedUuid) ?? null;
      resolve(selected);
    });

    child.stdin.write(rows.join("\n"));
    child.stdin.end();
  });
}

