import { CliError, defineArgs, ok, openUrlInBrowser, type CommandModule } from "@belzabar/core";
import { spawn } from "node:child_process";
import {
  PAGE_FINDER_CACHE_TTL_MS,
  collapsePairs,
  loadOrBuildPageFinderIndex,
  searchPageIndex,
  type PageFinderPage,
  type PageFinderComponent,
  type PageFinderMatch,
  type PageFinderIndex,
} from "../../lib/page-finder";

/** Default `--limit` for search / pick; `list` returns everything unless --limit is given. */
const DEFAULT_SEARCH_LIMIT = 20;

interface FindArgs {
  mode: "browse-pages" | "browse-components" | "search" | "pick";
  query?: string;
  type?: "page" | "component";
  refresh: boolean;
  limit: number | null;
  open: boolean;
  llm: boolean;
}

interface CacheMeta {
  source: "cache" | "fresh";
  generatedAt: number;
  ageMs: number;
  ttlMs: number;
  expiresAt: number;
  pageCount: number;
  componentCount: number;
}

interface FindBrowsePagesData {
  mode: "browse-pages";
  request: { refresh: boolean; limit: number | null };
  cache: CacheMeta;
  /** Pages before --limit. */
  total: number;
  pages: PageFinderPage[];
}

interface FindBrowseComponentsData {
  mode: "browse-components";
  request: { refresh: boolean; limit: number | null };
  cache: CacheMeta;
  /** Components (draft/published pairs collapsed) before --limit. */
  total: number;
  components: PageFinderComponent[];
}

interface FindSearchData {
  mode: "search";
  request: { query: string; type?: "page" | "component"; refresh: boolean; limit: number };
  cache: CacheMeta;
  /** Matches before --limit (PD-27: used to be counted after slicing). */
  totalMatches: number;
  matches: PageFinderMatch[];
}

interface FindPickData {
  mode: "pick";
  request: { query: string | null; refresh: boolean };
  cache: CacheMeta;
  status: "selected" | "cancelled";
  selected: PageFinderPage | PageFinderComponent | null;
  selectedType: "page" | "component" | null;
  opened: boolean;
}

type FindData =
  | FindBrowsePagesData
  | FindBrowseComponentsData
  | FindSearchData
  | FindPickData;

export const args = defineArgs({
  command: "belz pd find",
  positionals: [{ name: "query", variadic: true }],
  flags: {
    refresh: { type: "boolean" },
    open: { type: "boolean" },
    components: { type: "boolean" },
    limit: { type: "number", integer: true, min: 1, max: 1000 },
    type: { type: "enum", values: ["page", "component"], caseInsensitive: false },
  },
});

const command: CommandModule<FindArgs, FindData> = {
  schema: "pd.find",
  parseArgs(argv, context) {
    const { positionals, flags } = args.parse(argv);
    const { refresh, open, type } = flags;
    const limit = flags.limit ?? null;
    const llm = context?.outputMode === "llm";
    const positional = positionals.query;

    if (positional[0] === "list") {
      if (positional.length > 1) {
        throw new CliError("`belz pd find list` does not take a query.", {
          code: "LIST_DOES_NOT_ACCEPT_QUERY",
        });
      }
      return { mode: flags.components ? "browse-components" : "browse-pages", refresh, limit, open, llm };
    }

    if (positional[0] === "pick") {
      const query = positional.slice(1).join(" ").trim();
      return { mode: "pick", query: query || undefined, refresh, limit, open, llm };
    }

    const query = positional.join(" ").trim();
    if (!query && !refresh) {
      return { mode: "browse-pages", refresh, limit, open, llm };
    }

    return { mode: "search", query: query || undefined, type, refresh, limit, open, llm };
  },

  async execute({ mode, query, type, refresh, limit, open }, context) {
    if (open && mode !== "pick") {
      throw new CliError("--open is only supported with `belz pd find pick`.", {
        code: "OPEN_REQUIRES_PICK",
      });
    }

    const { index, source } = await loadOrBuildPageFinderIndex({ refresh });
    const ageMs = Math.max(0, Date.now() - index.generatedAt);

    if (source === "cache") {
      context.warn("Using cached page index. Use --refresh to fetch latest data.");
    }

    const cacheMeta: CacheMeta = {
      source,
      generatedAt: index.generatedAt,
      ageMs,
      ttlMs: PAGE_FINDER_CACHE_TTL_MS,
      expiresAt: index.generatedAt + PAGE_FINDER_CACHE_TTL_MS,
      pageCount: index.pageCount,
      componentCount: index.componentCount,
    };

    const clip = <T>(items: T[]): T[] => (limit === null ? items : items.slice(0, limit));

    if (mode === "browse-pages") {
      return ok<FindBrowsePagesData>({
        mode: "browse-pages",
        request: { refresh, limit },
        cache: cacheMeta,
        total: index.pages.length,
        pages: clip(index.pages),
      });
    }

    if (mode === "browse-components") {
      const components = collapsePairs(index.components);
      return ok<FindBrowseComponentsData>({
        mode: "browse-components",
        request: { refresh, limit },
        cache: cacheMeta,
        total: components.length,
        components: clip(components),
      });
    }

    if (mode === "pick") {
      if (context.outputMode === "llm") {
        throw new CliError("Interactive picker is not supported with --llm.", {
          code: "INTERACTIVE_NOT_SUPPORTED",
        });
      }

      const { selected, selectedType } = await runFzfPicker(index, query);
      const data: FindPickData = {
        mode: "pick",
        request: { query: query ?? null, refresh },
        cache: cacheMeta,
        status: selected ? "selected" : "cancelled",
        selected,
        selectedType,
        opened: false,
      };

      if (open && selected) {
        await openUrlInBrowser(selected.url);
        data.opened = true;
      }

      return ok(data);
    }

    const searchLimit = limit ?? DEFAULT_SEARCH_LIMIT;
    const { matches, total } = searchPageIndex(index, query ?? "", searchLimit, type);
    if (matches.length === 0) {
      context.warn("No page or component matches found.");
    }

    return ok<FindSearchData>({
      mode: "search",
      request: { query: query ?? "", type, refresh, limit: searchLimit },
      cache: cacheMeta,
      totalMatches: total,
      matches,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok || !envelope.data) return;

    const data = envelope.data as FindData;

    ui.success(
      `Indexed ${data.cache.pageCount} pages and ${data.cache.componentCount} components (${data.cache.source}).`
    );

    if (data.mode === "browse-pages") {
      if (data.pages.length === 0) {
        ui.info("No pages were found.");
        return;
      }
      ui.table(
        ["#", "Name", "Route", "ID", "Ref ID", "Status"],
        data.pages.map((page, i) => [
          i + 1,
          page.name,
          page.relativeRoute,
          page.id,
          page.referenceId,
          page.status,
        ])
      );
      return;
    }

    if (data.mode === "browse-components") {
      if (data.components.length === 0) {
        ui.info("No components were found.");
        return;
      }
      ui.table(
        ["#", "Name", "ID", "Ref ID", "Status"],
        data.components.map((comp, i) => [
          i + 1,
          comp.name,
          comp.id,
          comp.referenceId,
          comp.status,
        ])
      );
      return;
    }

    if (data.mode === "pick") {
      if (!data.selected) {
        ui.info("No item selected.");
        return;
      }
      const rows: Array<[string, string]> = [
        ["Name", data.selected.name],
        ["Type", data.selectedType ?? ""],
        ["ID", data.selected.id],
        ["Reference ID", data.selected.referenceId],
        ["Status", data.selected.status],
        ["URL", data.selected.url],
      ];
      if (data.selectedType === "page") {
        const page = data.selected as PageFinderPage;
        rows.push(["Route", page.relativeRoute]);
      }
      ui.table(["Property", "Value"], rows);
      if (data.opened) {
        ui.success("Opened selected item in browser.");
      }
      return;
    }

    if (data.mode === "search") {
      if (data.matches.length === 0) {
        ui.info(`No matches found for '${data.request.query}'.`);
        return;
      }
      ui.table(
        ["#", "Type", "Name", "Route/Status", "ID", "Ref ID", "Score"],
        data.matches.map((match, i) => {
          if (match.type === "page") {
            return [
              i + 1,
              "page",
              match.name,
              match.relativeRoute,
              match.id,
              match.referenceId,
              match.score,
            ];
          }
          return [
            i + 1,
            "component",
            match.name,
            match.status,
            match.id,
            match.referenceId,
            match.score,
          ];
        })
      );
      if (data.totalMatches > data.matches.length) {
        ui.text(`Showing ${data.matches.length} of ${data.totalMatches} matches (raise --limit for more).`);
      }
      ui.text("Tip: run 'belz pd show <id>' for full details.");
    }
  },
};

export default command;

function runFzfPicker(
  index: PageFinderIndex,
  query?: string
): Promise<{ selected: PageFinderPage | PageFinderComponent | null; selectedType: "page" | "component" | null }> {
  const allItems: Array<{ item: PageFinderPage | PageFinderComponent; type: "page" | "component" }> = [
    ...index.pages.map(p => ({ item: p as PageFinderPage | PageFinderComponent, type: "page" as const })),
    ...index.components.map(c => ({ item: c as PageFinderPage | PageFinderComponent, type: "component" as const })),
  ].sort((a, b) => {
    const typeOrder = a.type.localeCompare(b.type);
    if (typeOrder !== 0) return typeOrder;
    return a.item.name.localeCompare(b.item.name);
  });

  if (allItems.length === 0) return Promise.resolve({ selected: null, selectedType: null });

  const rows = allItems.map(({ item, type }) => {
    const route = type === "page" ? (item as PageFinderPage).relativeRoute : "";
    return [type, item.name, route, item.id].join("\t");
  });

  const fzfArgs = [
    "--delimiter", "\t",
    "--with-nth", "1,2,3",
    "--prompt", "Page/Component> ",
    "--height", "85%",
    "--layout", "reverse",
    "--border",
    "--cycle",
  ];

  if (query) {
    fzfArgs.push("--query", query);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("fzf", fzfArgs, { stdio: ["pipe", "pipe", "pipe"] });

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

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    child.on("close", (code: number | null) => {
      if (missingBinary) {
        reject(
          new CliError(
            "fzf is not installed. Install fzf or use `belz pd find <query>` for non-interactive search.",
            { code: "FZF_NOT_INSTALLED" }
          )
        );
        return;
      }

      if (code === 130 || code === 1) {
        resolve({ selected: null, selectedType: null });
        return;
      }

      if (code !== 0) {
        reject(
          new CliError(`fzf failed${stderr ? `: ${stderr.trim()}` : "."}`, { code: "FZF_FAILED" })
        );
        return;
      }

      const line = stdout.trim();
      if (!line) {
        resolve({ selected: null, selectedType: null });
        return;
      }

      const parts = line.split("\t");
      const selectedId = parts[3]?.trim();
      if (!selectedId) {
        resolve({ selected: null, selectedType: null });
        return;
      }

      const found = allItems.find(({ item }) => item.id === selectedId);
      if (!found) {
        resolve({ selected: null, selectedType: null });
        return;
      }

      resolve({ selected: found.item, selectedType: found.type });
    });

    child.stdin.write(rows.join("\n"));
    child.stdin.end();
  });
}

