import { CliError, defineSubcommands, lifecycle, ok, openUrlInBrowser, type CommandModule, type FlagsSpec } from "@belzabar/core";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import { abbreviate, parseFieldList, projectRow, type FieldSelection } from "../../lib/compact";
import { spawn } from "node:child_process";
import {
  type MethodFinderIndex,
  METHOD_FINDER_CACHE_TTL_MS,
  METHOD_FINDER_SCHEMA,
  describeSearch,
  listMethodFinderCategories,
  loadOrBuildMethodFinderIndex,
  searchMethodIndex,
  type MethodFinderMethod,
  type MethodFinderCategory,
  type MethodFinderMatch,
} from "../../lib/method-finder";

interface FindArgs {
  mode: "browse" | "search" | "pick" | "describe";
  query?: string;
  refresh: boolean;
  limit: number;
  open: boolean;
  raw: boolean;
  /** `--category <prefix>`: only categories whose name starts with it. */
  category?: string;
  fields?: FieldSelection;
}

type Row = Record<string, unknown>;

/** Index freshness (7.9: compact — no ttl/expiry arithmetic for the caller to do). */
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

type FindData = FindBrowseData | FindSearchData | FindDescribeData | FindPickData;

// ── Compact rows (7.9) ──────────────────────────────────────────────────────
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

function methodRow(m: MethodFinderMethod & { score?: number; matched?: string[] }, sel: FieldSelection, defaults: string[], typed: boolean): Row {
  const full: Row = {
    ...(typed ? { type: "method" } : {}),
    name: m.methodName,
    alias: m.aliasName && m.aliasName !== m.methodName ? m.aliasName : undefined,
    category: m.categoryName,
    state: m.state,
    uuid: m.uuid,
    referenceId: m.referenceId,
    apiUuid: m.automationApiUuid,
    summary: sel.mode === "default" && m.summary ? abbreviate(m.summary, 120) : m.summary,
    description: m.description,
    version: m.version,
    categoryUuid: m.categoryUuid,
    createdOn: m.createdOn,
    updatedOn: m.updatedOn,
    url: m.url,
    score: m.score,
    matched: m.matched,
  };
  return projectRow(full, sel, defaults);
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
  return projectRow(full, sel, DEFAULT_CATEGORY_FIELDS);
}

/** `--raw` payload: the index capped at `--limit` methods and categories (F29: was 1.6 MB). */
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

const SUBCOMMANDS = new Set(["list", "pick", "search"]);
const VALUE_FLAGS = new Set(["--limit", "--env", "--category", "--fields"]);

/**
 * `ad find --refresh list` worked before defineSubcommands (s3-review): if
 * flags come first, move the first bare subcommand name to the front.
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

const FIND_FLAGS = {
  ...AD_COMMON_FLAGS,
  refresh: { type: "boolean" },
  raw: { type: "boolean" },
  open: { type: "boolean" },
  limit: { type: "number", integer: true, min: 1, max: 200, default: 20 },
  describe: { type: "boolean" },
  category: { type: "string" },
  fields: { type: "string" },
} as const satisfies FlagsSpec;

export const args = defineSubcommands(
  {
    list: { flags: FIND_FLAGS, codes: { UNEXPECTED_ARGUMENT: "LIST_DOES_NOT_ACCEPT_QUERY" } },
    pick: { positionals: [{ name: "query", variadic: true }], flags: FIND_FLAGS },
    search: { positionals: [{ name: "query", variadic: true }], flags: FIND_FLAGS },
  },
  { command: "belz ad find", default: "search" },
);

const command: CommandModule<FindArgs, FindData> = {
  schema: "ad.find",
  parseArgs(argv) {
    const parsed = args.parse(subcommandFirst(argv));
    const { refresh, raw, open, limit, describe, category } = parsed.flags;
    resolveAdCommon(parsed.flags, "list", "find");
    const query = parsed.subcommand === "list" ? "" : parsed.positionals.query.join(" ").trim();
    if (describe && (parsed.subcommand !== "search" || !query)) {
      throw new CliError("--describe needs search words: `belz ad find --describe <text>`.", { code: "MISSING_QUERY" });
    }
    const mode: FindArgs["mode"] =
      parsed.subcommand === "pick" ? "pick" : describe ? "describe" : query ? "search" : "browse";
    const known: readonly string[] = mode === "browse" ? CATEGORY_FIELDS : [...new Set<string>([...METHOD_FIELDS, ...CATEGORY_FIELDS])];
    const fields = parseFieldList(parsed.flags.fields, known);
    return { mode, query: query || undefined, refresh, limit, open, raw, category: category?.trim() || undefined, fields };
  },
  async execute({ mode, query, refresh, limit, open, raw, category, fields }, context) {
    const sel: FieldSelection = fields ?? { mode: "default" };
    if (open && mode !== "pick") {
      throw new CliError("--open is only supported with `belz ad find pick`.", {
        code: "OPEN_REQUIRES_PICK",
      });
    }

    // F30: fzf needs a terminal; fail cleanly before any work when there is none.
    if (mode === "pick" && context.outputMode !== "llm" && !(process.stdin.isTTY && process.stderr.isTTY)) {
      throw new CliError("Interactive picker needs a terminal (stdin/stderr are not a TTY). Use `belz ad find <query>`.", {
        code: "INTERACTIVE_NOT_SUPPORTED",
      });
    }

    // F29: a rebuild walks every category (minutes on big envs) — report progress
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
    if (ageMs > METHOD_FINDER_CACHE_TTL_MS) context.warn("Method index is older than its TTL — use --refresh.");

    const inCategory = (name: string) => !category || name.toLowerCase().startsWith(category.toLowerCase());

    if (mode === "browse") {
      const categories = listMethodFinderCategories(index).filter((c) => inCategory(c.name)).map((c) => categoryRow(c, sel, false));

      const data: FindBrowseData = {
        mode: "browse",
        cache: cacheMeta,
        categories,
      };

      if (raw) {
        data.raw = rawIndex(index, limit);
      }

      return ok(data);
    }

    if (mode === "pick") {
      if (context.outputMode === "llm") {
        throw new CliError("Interactive picker is not supported with --llm.", {
          code: "INTERACTIVE_NOT_SUPPORTED",
        });
      }

      const selected = await runFzfPicker(index.methods.filter((m) => inCategory(m.categoryName)), query);
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
        data.raw = rawIndex(index, limit);
      }

      return ok(data);
    }

    const searchQuery = query ?? "";
    if (mode === "describe") {
      const found = describeSearch(index, searchQuery, limit, { category });
      if (found.length === 0) context.warn("No method summary/description matches found.");
      const data: FindDescribeData = {
        mode: "describe",
        query: searchQuery,
        cache: cacheMeta,
        totalMatches: found.length,
        matches: found.map((m) => methodRow(m, sel, DEFAULT_DESCRIBE_FIELDS, false)),
      };
      return ok(data);
    }

    const scoped = category
      ? { ...index, methods: index.methods.filter((m) => inCategory(m.categoryName)), categories: index.categories.filter((c) => inCategory(c.name)) }
      : index;
    const matches: MethodFinderMatch[] = searchMethodIndex(scoped, searchQuery, limit);
    if (matches.length === 0) {
      context.warn("No method or category matches found.");
    }

    const data: FindSearchData = {
      mode: "search",
      query: searchQuery,
      cache: cacheMeta,
      totalMatches: matches.length,
      matches: matches.map((m) => (m.type === "method" ? methodRow(m, sel, DEFAULT_METHOD_FIELDS, true) : categoryRow(m, sel, true))),
    };

    if (raw) {
      data.raw = rawIndex(index, limit);
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
      ui.text(`Tip: run 'belz ad show ${data.selected.uuid}' for full details.`);
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
    if (data.mode !== "browse") ui.text("Tip: run 'belz ad show <uuid> --compact' to inspect a matched method.");
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
            "fzf is not installed. Install fzf or use `belz ad find <query>` for non-interactive search.",
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

