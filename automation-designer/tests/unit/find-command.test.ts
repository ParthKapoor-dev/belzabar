import { describe, expect, test } from "bun:test";
import type { CommandContext } from "@belzabar/core";
import findCommandModule from "../../commands/find/index";

const command = (findCommandModule as { default?: typeof findCommandModule }).default ?? (findCommandModule as any);

const context: CommandContext = {
  outputMode: "human",
  env: {
    name: "nsm-dev",
    project: "NSM",
    baseUrl: "https://nsm-dev.nc.verifi.dev",
    credentials: {
      loginId: "",
      passwordEncoded: "",
    },
  },
  binaryName: "belz",
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
