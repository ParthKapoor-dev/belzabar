import { CliError, defineSubcommands, lifecycle, ok, openUrlInBrowser, type CommandModule, type FlagsSpec } from "@belzabar/core";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import { spawn } from "node:child_process";
import {
  type MethodFinderIndex,
  METHOD_FINDER_CACHE_TTL_MS,
  listMethodFinderCategories,
  loadOrBuildMethodFinderIndex,
  searchMethodIndex,
  type MethodFinderMethod,
  type MethodFinderCategory,
  type MethodFinderMatch,
} from "../../lib/method-finder";

interface FindArgs {
  mode: "browse" | "search" | "pick";
  query?: string;
  refresh: boolean;
  limit: number;
  open: boolean;
  raw: boolean;
}

interface CacheMeta {
  source: "cache" | "fresh";
  generatedAt: number;
  ageMs: number;
  ttlMs: number;
  expiresAt: number;
  categoryCount: number;
  methodCount: number;
  skippedCategoryCount: number;
}

interface FindBrowseData {
  mode: "browse";
  request: {
    query: null;
    refresh: boolean;
    limit: number;
  };
  cache: CacheMeta;
  categories: MethodFinderCategory[];
  raw?: RawIndexView;
}

interface FindSearchData {
  mode: "search";
  request: {
    query: string;
    refresh: boolean;
    limit: number;
  };
  cache: CacheMeta;
  totalMatches: number;
  matches: MethodFinderMatch[];
  raw?: RawIndexView;
}

interface FindPickData {
  mode: "pick";
  request: {
    query: string | null;
    refresh: boolean;
    limit: number;
  };
  cache: CacheMeta;
  status: "selected" | "cancelled";
  selected: MethodFinderMethod | null;
  opened: boolean;
  raw?: RawIndexView;
}

type FindData = FindBrowseData | FindSearchData | FindPickData;

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
const VALUE_FLAGS = new Set(["--limit", "--env"]);

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
    const { refresh, raw, open, limit } = parsed.flags;
    resolveAdCommon(parsed.flags, "list", "find");
    const query = parsed.subcommand === "list" ? "" : parsed.positionals.query.join(" ").trim();
    const mode: FindArgs["mode"] =
      parsed.subcommand === "pick" ? "pick" : query ? "search" : "browse";
    return { mode, query: query || undefined, refresh, limit, open, raw };
  },
  async execute({ mode, query, refresh, limit, open, raw }, context) {
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
      ageMs,
      ttlMs: METHOD_FINDER_CACHE_TTL_MS,
      expiresAt: index.generatedAt + METHOD_FINDER_CACHE_TTL_MS,
      categoryCount: index.categoryCount,
      methodCount: index.methodCount,
      skippedCategoryCount: index.skippedCategories.length,
    };

    if (cacheMeta.skippedCategoryCount > 0) {
      context.warn(
        `${cacheMeta.skippedCategoryCount} categories could not be fully indexed due to API access or fetch errors.`
      );
    }

    if (mode === "browse") {
      const categories = listMethodFinderCategories(index);

      const data: FindBrowseData = {
        mode: "browse",
        request: {
          query: null,
          refresh,
          limit,
        },
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

      const selected = await runFzfPicker(index.methods, query);
      const data: FindPickData = {
        mode: "pick",
        request: {
          query: query ?? null,
          refresh,
          limit,
        },
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
    const matches = searchMethodIndex(index, searchQuery, limit);
    if (matches.length === 0) {
      context.warn("No method or category matches found.");
    }

    const data: FindSearchData = {
      mode: "search",
      request: {
        query: searchQuery,
        refresh,
        limit,
      },
      cache: cacheMeta,
      totalMatches: matches.length,
      matches,
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
      `Indexed ${data.cache.methodCount} methods across ${data.cache.categoryCount} categories (${data.cache.source}).`
    );

    if (data.cache.skippedCategoryCount > 0) {
      ui.warn(
        `${data.cache.skippedCategoryCount} categories could not be fully indexed due to API access or fetch errors.`
      );
    }

    if (data.mode === "browse") {
      if (data.categories.length === 0) {
        ui.info("No categories were found.");
        return;
      }

      ui.table(
        ["#", "Category", "ID", "Category UUID", "Methods"],
        data.categories.map((category, index) => [
          index + 1,
          category.name,
          category.chainCategoryId ?? "",
          category.uuid,
          category.methodCount,
        ])
      );
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
      ui.text(`Tip: run 'belz ad show ${data.selected.uuid}' for full details.`);
      return;
    }

    if (data.matches.length === 0) {
      ui.info(`No matches found for '${data.request.query}'.`);
      return;
    }

    ui.table(
      ["#", "Type", "Name", "Alias", "UUID", "Ref ID", "State", "Category", "Methods", "Score"],
      data.matches.map((match, index) => {
        if (match.type === "method") {
          return [
            index + 1,
            "method",
            match.methodName,
            match.aliasName,
            match.uuid,
            match.referenceId,
            match.state,
            match.categoryName,
            "",
            match.score,
          ];
        }

        return [
          index + 1,
          "category",
          match.name,
          match.aliasNames.join(", "),
          match.uuid,
          "",
          "",
          match.name,
          match.methodCount,
          match.score,
        ];
      })
    );

    ui.text("Tip: run 'belz ad show <uuid>' to inspect a matched method.");
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

