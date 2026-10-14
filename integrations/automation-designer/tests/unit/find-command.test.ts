import { describe, expect, test } from "bun:test";
import type { CommandContext } from "@belzabar/core";
import findCommandModule from "../../commands/find/index";

const command = (findCommandModule as { default?: typeof findCommandModule }).default ?? (findCommandModule as any);

const context: CommandContext = {
  outputMode: "human",
  env: {
    name: "orb-dev",
    project: "ORB",
    baseUrl: "https://orb-dev.nc.vendor.example",
    credentials: {
      loginId: "",
      password: "",
    },
  },
  envExplicit: false,
  verbose: false,
  binaryName: "wi-impl",
  commandName: "find",
  warn: () => {},
};

describe("find command parseArgs", () => {
  test("defaults to browse mode with no args", () => {
    const parsed = command.parseArgs([], context);
    expect(parsed.mode).toBe("browse");
    expect(parsed.query).toBeUndefined();
    expect(parsed.limit).toBe(20);
    expect(parsed.open).toBe(false);
  });

  test("parses explicit list mode", () => {
    const parsed = command.parseArgs(["list"], context);
    expect(parsed.mode).toBe("browse");
    expect(parsed.query).toBeUndefined();
  });

  test("parses pick mode with optional seed query", () => {
    const parsed = command.parseArgs(["pick", "lookup", "dcin"], context);
    expect(parsed.mode).toBe("pick");
    expect(parsed.query).toBe("lookup dcin");
  });

  test("parses pick mode with --open", () => {
    const parsed = command.parseArgs(["pick", "_lookupDCIN", "--open"], context);
    expect(parsed.mode).toBe("pick");
    expect(parsed.query).toBe("_lookupDCIN");
    expect(parsed.open).toBe(true);
  });

  test("parses search mode with query and flags", () => {
    const parsed = command.parseArgs(["_lookupDCIN", "--limit", "5", "--refresh"], context);
    expect(parsed.mode).toBe("search");
    expect(parsed.query).toBe("_lookupDCIN");
    expect(parsed.limit).toBe(5);
    expect(parsed.refresh).toBe(true);
  });

  test("throws when list receives a query", () => {
    expect(() => command.parseArgs(["list", "extra"], context)).toThrow();
  });

  test("rejects --open outside pick mode", async () => {
    await expect(
      command.execute(
        {
          mode: "search",
          query: "_lookupDCIN",
          refresh: false,
          limit: 20,
          open: true,
          raw: false,
        },
        context
      )
    ).rejects.toMatchObject({
      code: "OPEN_REQUIRES_PICK",
    });
  });
});

// ─── flags before the subcommand ─────────────────────────────────────────
import { fakeFetch, respond, withTempEnvConfig } from "@belzabar/core/testing";
import { rawIndex, subcommandFirst } from "../../commands/find/index";
import { loadOrBuildMethodFinderIndex, type MethodFinderIndex } from "../../lib/method-finder";

describe("find: flags before the subcommand", () => {
  test("`--refresh list` is list mode again", () => {
    expect(subcommandFirst(["--refresh", "list"])).toEqual(["list", "--refresh"]);
    const parsed = command.parseArgs(["--refresh", "list"], context);
    expect(parsed.mode).toBe("browse");
    expect(parsed.refresh).toBe(true);
  });
  test("value flags are skipped; a plain query is untouched", () => {
    expect(subcommandFirst(["--limit", "5", "pick", "x"])).toEqual(["pick", "--limit", "5", "x"]);
    expect(subcommandFirst(["--limit", "5", "someQuery"])).toEqual(["--limit", "5", "someQuery"]);
    expect(subcommandFirst(["list"])).toEqual(["list"]);
  });
});

describe("find pick without a terminal", () => {
  test("human mode → INTERACTIVE_NOT_SUPPORTED before any fetch", async () => {
    const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(
        command.execute({ mode: "pick", refresh: false, limit: 20, open: false, raw: false }, context),
      ).rejects.toMatchObject({ code: "INTERACTIVE_NOT_SUPPORTED" });
    } finally {
      if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});

describe("find --raw honours --limit", () => {
  test("index capped, truncation counted", () => {
    const index = {
      env: "e", generatedAt: 0, skippedCategories: [], categoryCount: 3, methodCount: 50,
      categories: [1, 2, 3].map((i) => ({ uuid: `c${i}`, name: `c${i}`, label: "", aliasNames: [], methodCount: 0 })),
      methods: Array.from({ length: 50 }, (_, i) => ({ uuid: `m${i}` })),
    } as unknown as MethodFinderIndex;
    const view = rawIndex(index, 2);
    expect(view.index.methods.length).toBe(2);
    expect(view.index.categories.length).toBe(2);
    expect(view.truncated).toEqual({ methods: 48, categories: 1 });
  });
});

describe("find index rebuild", () => {
  test("reports progress per category and keeps chain-category id + trimmed uuids", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-find": { url: "https://t-find.test" } }, activeEnv: "t-find" });
    const cats = [
      { id: 1135, uuid: "4e98700b2524e2accd47b4addf95ceca    ", automationSystemUuid: "4037ada88a1a3ac30a1c9e63b6b0eed6    ", name: "Test-Tester" },
      { id: 15, uuid: "4c1eb487ee7f4be7c4bfb246809bce25", name: "Schools" },
      { id: 7, uuid: "4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Other" },
    ];
    using ff = fakeFetch({
      "GET /rest/api/automation/services*": respond({ json: { currentOffset: 3, result: cats } }),
      "GET /rest/api/automation/methods*": respond({ json: { methodList: [] } }),
    }).install();
    const seen: Array<[number, number]> = [];
    const { index } = await loadOrBuildMethodFinderIndex({ refresh: true, onProgress: (p) => seen.push([p.done, p.total]) });
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
    const tp = index.categories.find((c) => c.name === "Test-Tester")!;
    expect(tp).toMatchObject({ chainCategoryId: 1135, uuid: "4e98700b2524e2accd47b4addf95ceca", systemUuid: "4037ada88a1a3ac30a1c9e63b6b0eed6" });
    expect(ff.requests.filter((r) => r.url.includes("/automation/methods")).length).toBe(3);
  });
});
