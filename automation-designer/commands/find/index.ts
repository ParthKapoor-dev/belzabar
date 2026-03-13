import { CliError, ok, type CommandModule } from "@belzabar/core";
import { spawn } from "node:child_process";
import {
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
  raw?: {
    index: unknown;
  };
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
  raw?: {
    index: unknown;
  };
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
  raw?: {
    index: unknown;
  };
}

type FindData = FindBrowseData | FindSearchData | FindPickData;

function parseLimit(value: string | undefined): number {
  if (!value) {
    throw new CliError("--limit requires a numeric value.", {
      code: "MISSING_LIMIT",
    });
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    throw new CliError("--limit must be a positive integer.", {
      code: "INVALID_LIMIT",
    });
  }

  if (parsed > 200) {
    throw new CliError("--limit cannot be greater than 200.", {
      code: "LIMIT_TOO_HIGH",
    });
  }

  return parsed;
}

const command: CommandModule<FindArgs, FindData> = {
  schema: "ad.find",
  parseArgs(args) {
    let refresh = false;
    let raw = false;
    let open = false;
    let limit = 20;
    const positional: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const token = args[i] ?? "";

      if (token === "--refresh") {
        refresh = true;
        continue;
      }

      if (token === "--raw") {
        raw = true;
        continue;
      }

      if (token === "--open") {
        open = true;
        continue;
      }

      if (token === "--limit") {
        limit = parseLimit(args[i + 1]);
        i += 1;
        continue;
      }

      if (token.startsWith("-")) {
        throw new CliError(`Unknown flag: ${token}`, {
          code: "UNKNOWN_FLAG",
        });
      }

      positional.push(token);
    }

    if (positional[0] === "list") {
      if (positional.length > 1) {
        throw new CliError("`belz ad find list` does not take a query.", {
          code: "LIST_DOES_NOT_ACCEPT_QUERY",
        });
      }
      return {
        mode: "browse",
        query: undefined,
        refresh,
        limit,
        open,
        raw,
      };
    }

    if (positional[0] === "pick") {
      const query = positional.slice(1).join(" ").trim();
      return {
        mode: "pick",
        query: query || undefined,
        refresh,
        limit,
        open,
        raw,
      };
    }

    const query = positional.join(" ").trim();

    return {
      mode: query ? "search" : "browse",
      query: query || undefined,
      refresh,
      limit,
      open,
      raw,
    };
  },
  async execute({ mode, query, refresh, limit, open, raw }, context) {
    if (open && mode !== "pick") {
      throw new CliError("--open is only supported with `belz ad find pick`.", {
        code: "OPEN_REQUIRES_PICK",
      });
    }

    const { index, source } = await loadOrBuildMethodFinderIndex({ refresh });
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
        data.raw = { index };
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
        data.raw = { index };
      }

      return ok(data);
    }

    const matches = searchMethodIndex(index, query, limit);
    if (matches.length === 0) {
      context.warn("No method or category matches found.");
    }

    const data: FindSearchData = {
      mode: "search",
      request: {
        query,
        refresh,
        limit,
      },
      cache: cacheMeta,
      totalMatches: matches.length,
      matches,
    };

    if (raw) {
      data.raw = { index };
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
        ["#", "Category", "Category UUID", "Methods"],
        data.categories.map((category, index) => [
          index + 1,
          category.name,
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

async function openUrlInBrowser(url: string): Promise<void> {
  const candidate = getUrlOpenCommand(url);
  const result = await runCommand(candidate.command, candidate.args);

  if (result.code !== 0) {
    throw new CliError(`Failed to open browser URL: ${result.stderr || `exit code ${String(result.code)}`}`, {
      code: "OPEN_FAILED",
    });
  }
}

function getUrlOpenCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

function runCommand(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new CliError(
            `Cannot open URL automatically because '${command}' is not installed.`,
            { code: "OPEN_COMMAND_NOT_FOUND" }
          )
        );
        return;
      }
      reject(error);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      resolve({ code, stderr: stderr.trim() });
    });
  });
}
