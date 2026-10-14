import { describe, expect, test } from "bun:test";
import { declaresFlag, defineArgs, defineSubcommands, suggest } from "../src/args";
import { checkCommandDocs, flagsMentioned } from "../src/testing/doc-check";
import { CliError } from "../src/command";
import { thrownCliError as err } from "../src/testing/errors";

const show = defineArgs({
  command: "wi-impl ad show",
  positionals: [{ name: "uuid", required: true }],
  flags: {
    step: { type: "number", integer: true, min: 1, alias: ["--service-detail"] },
    full: { type: "boolean" },
    open: { type: "boolean", alias: ["-o"] },
    "dry-run": { type: "boolean" },
    mode: { type: "enum", values: ["read", "update"] as const, default: "read" },
    tag: { type: "string", repeatable: true },
    body: { type: "string" },
    limit: { type: "number", default: 20 },
    offset: { type: "number" },
  },
});

describe("defineArgs: values", () => {
  test("defaults and typed values", () => {
    const r = show.parse(["abc"]);
    expect(r.positionals.uuid).toBe("abc");
    expect(r.flags).toEqual({
      step: undefined,
      full: false,
      open: false,
      dryRun: false,
      mode: "read",
      tag: [],
      body: undefined,
      limit: 20,
      offset: undefined,
    });
    expect(r.provided.size).toBe(0);
  });

  test("--flag value, --flag=value, aliases, repeatable, enum case-insensitive", () => {
    const r = show.parse(["--service-detail", "2", "abc", "-o", "--mode=UPDATE", "--tag", "a", "--tag=b", "--dry-run"]);
    expect(r.flags.step).toBe(2);
    expect(r.flags.open).toBe(true);
    expect(r.flags.mode).toBe("update");
    expect(r.flags.tag).toEqual(["a", "b"]);
    expect(r.flags.dryRun).toBe(true);
    expect(r.provided.has("step")).toBe(true);
    expect(show.parse(["abc", "--step=3"]).flags.step).toBe(3);
  });

  test("negative numbers are values, not flags", () => {
    expect(show.parse(["abc", "--offset", "-5"]).flags.offset).toBe(-5);
    expect(show.parse(["-5"]).positionals.uuid).toBe("-5");
    expect(show.parse(["abc", "--body", "-"]).flags.body).toBe("-");
    expect(show.parse(["abc", "--body", "- bullet"]).flags.body).toBe("- bullet");
  });

  test("`--` ends flag parsing", () => {
    const r = show.parse(["--", "--full"]);
    expect(r.positionals.uuid).toBe("--full");
    expect(r.flags.full).toBe(false);
    expect(r.afterDoubleDash).toEqual(["--full"]);
  });

  test("global flags that reach the parser are skipped", () => {
    const r = show.parse(["abc", "--llm", "--env", "x", "-v", "--env=y"]);
    expect(r.positionals.uuid).toBe("abc");
  });
});

describe("defineArgs: errors", () => {
  test("unknown flag with did-you-mean", () => {
    const e = err(() => show.parse(["abc", "--ful"]));
    expect(e.code).toBe("UNKNOWN_FLAG");
    expect(e.message).toContain("Did you mean '--full'");
    expect((e.details as any).suggestion).toBe("--full");
    expect((err(() => show.parse(["abc", "--zzzzzzzzzzzz"])).details as any).suggestion).toBeNull();
  });

  test("missing value / flag-looking value", () => {
    expect(err(() => show.parse(["abc", "--body"])).code).toBe("MISSING_VALUE");
    expect(err(() => show.parse(["abc", "--body", "--full"])).code).toBe("MISSING_VALUE");
    expect(err(() => show.parse(["abc", "--body", "--"])).code).toBe("MISSING_VALUE");
    expect(err(() => show.parse(["abc", "--body="])).code).toBe("MISSING_VALUE");
    expect(err(() => show.parse(["abc", "--step"])).code).toBe("MISSING_VALUE");
  });

  test("invalid values", () => {
    expect(err(() => show.parse(["abc", "--step", "x"])).code).toBe("INVALID_VALUE");
    expect(err(() => show.parse(["abc", "--step", "1.5"])).code).toBe("INVALID_VALUE");
    expect(err(() => show.parse(["abc", "--step", "0"])).code).toBe("INVALID_VALUE");
    expect(err(() => show.parse(["abc", "--mode", "delete"])).code).toBe("INVALID_VALUE");
    expect(err(() => show.parse(["abc", "--full=true"])).code).toBe("INVALID_VALUE");
  });

  test("duplicates, missing and extra positionals", () => {
    expect(err(() => show.parse(["abc", "--step", "1", "--service-detail", "2"])).code).toBe("DUPLICATE_FLAG");
    expect(err(() => show.parse([])).code).toBe("MISSING_ARGUMENT");
    expect(err(() => show.parse(["a", "b"])).code).toBe("UNEXPECTED_ARGUMENT");
  });

  test("required flags, exclusive and one-of groups, custom codes", () => {
    const d = defineArgs({
      flags: {
        user: { type: "boolean" },
        system: { type: "boolean" },
        overlay: { type: "string" },
        config: { type: "string" },
        uuid: { type: "string", required: true, missingCode: "MISSING_UUID" },
      },
      exclusive: [["user", "system"], ["overlay", "config"]],
      requireOneOf: [["overlay", "config"]],
      codes: { UNKNOWN_FLAG: "X_UNKNOWN" },
    });
    expect(err(() => d.parse(["--overlay", "f"])).code).toBe("MISSING_UUID");
    expect(err(() => d.parse(["--uuid", "u"])).code).toBe("MISSING_FLAG");
    expect(err(() => d.parse(["--uuid", "u", "--overlay", "a", "--config", "b"])).code).toBe("CONFLICTING_FLAGS");
    expect(err(() => d.parse(["--uuid", "u", "--overlay", "a", "--user", "--system"])).code).toBe("CONFLICTING_FLAGS");
    expect(err(() => d.parse(["--nope"])).code).toBe("X_UNKNOWN");
    const ok = d.parse(["--uuid", "u", "--config", "c"]);
    expect(ok.flags.uuid).toBe("u");
    expect(ok.flags.config).toBe("c");
  });

  test("variadic and extra positionals", () => {
    const d = defineArgs({ positionals: [{ name: "action", required: true }, { name: "query", variadic: true }] });
    expect(d.parse(["pick", "a", "b"]).positionals).toEqual({ action: "pick", query: ["a", "b"] });
    const req = defineArgs({ positionals: [{ name: "q", variadic: true, required: true, missingCode: "MISSING_QUERY" }] });
    expect(err(() => req.parse([])).code).toBe("MISSING_QUERY");
    const e = defineArgs({ positionals: [{ name: "x" }], allowExtraPositionals: true });
    expect(e.parse(["a", "b", "c"]).extra).toEqual(["b", "c"]);
  });

  test("bad specs are rejected at definition time", () => {
    expect(() => defineArgs({ flags: { a: { type: "string", alias: ["--b"] }, b: { type: "boolean" } } })).toThrow();
    expect(() => defineArgs({ flags: { a: { type: "boolean", required: true } } })).toThrow();
    expect(() => defineArgs({ positionals: [{ name: "a", variadic: true }, { name: "b" }] })).toThrow();
    expect(() => defineArgs({ flags: {}, exclusive: [["x"]] })).toThrow();
  });
});

describe("defineSubcommands", () => {
  const history = defineSubcommands(
    {
      list: { positionals: [{ name: "uuid", required: true }], flags: { limit: { type: "number" } } },
      restore: { positionals: [{ name: "uuid", required: true }], flags: { version: { type: "number", required: true } } },
      search: { positionals: [{ name: "query", variadic: true }] },
    },
    { command: "wi-impl ad history", aliases: { ls: "list" } },
  );

  test("routes on argv[0]", () => {
    const r = history.parse(["restore", "u1", "--version", "3"]);
    expect(r.subcommand).toBe("restore");
    if (r.subcommand === "restore") expect(r.flags.version).toBe(3);
    expect(history.parse(["ls", "u1"]).subcommand).toBe("list");
  });

  test("missing / unknown subcommand", () => {
    expect(err(() => history.parse([])).code).toBe("MISSING_SUBCOMMAND");
    const e = err(() => history.parse(["restor", "u"]));
    expect(e.code).toBe("UNKNOWN_SUBCOMMAND");
    expect(e.message).toContain("Did you mean 'restore'");
    expect(err(() => history.parse(["list", "u", "--version", "1"])).message).toContain("wi-impl ad history list");
  });

  test("default subcommand parses the whole argv", () => {
    const find = defineSubcommands(
      { list: {}, search: { positionals: [{ name: "query", variadic: true }] } },
      { default: "search" },
    );
    const r = find.parse(["foo", "bar"]);
    expect(r.subcommand).toBe("search");
    expect(find.parse(["list"]).subcommand).toBe("list");
  });

  test("declaresFlag unions subcommand flags", () => {
    expect(declaresFlag(history, "--version")).toBe(true);
    expect(declaresFlag(history, "--verbose")).toBe(false);
    expect(declaresFlag(undefined, "--verbose")).toBe(false);
  });
});

describe("doc check", () => {
  const def = defineArgs({
    positionals: [{ name: "uuid", required: true }],
    flags: { full: { type: "boolean" }, step: { type: "number", alias: ["--service-detail"] } },
  });

  test("in sync", () => {
    const help = "Usage: wi-impl ad show <uuid> [flags]\n  --full\n  --step, --service-detail <N>\n  --llm\n";
    const desc = "wi-impl ad show <uuid>  :->  Show it\nwi-impl ad show <uuid> --full  :->  Everything\n";
    expect(checkCommandDocs({ invocation: "wi-impl ad show", def, help, desc })).toEqual([]);
  });

  test("drift is reported", () => {
    const help = "wi-impl ad show <uuid>\n  --full\n  --bogus\n";
    const desc = "  show <uuid>   Show it\n";
    const problems = checkCommandDocs({ invocation: "wi-impl ad show", def, help, desc });
    expect(problems.some(p => p.includes("does not document --step"))).toBe(true);
    expect(problems.some(p => p.includes("--service-detail"))).toBe(true);
    expect(problems.some(p => p.includes("mentions --bogus"))).toBe(true);
    expect(problems.some(p => p.includes("must start with 'Usage: wi-impl ad show'"))).toBe(true);
    expect(problems.some(p => p.startsWith("desc.txt line"))).toBe(true);
  });

  test("helpers", () => {
    expect(flagsMentioned("use --a-b or --c=1, not x--y")).toEqual(["--a-b", "--c"]);
    expect(suggest("--dryrun", ["--dry-run", "--raw"])).toBe("--dry-run");
  });
});

describe("dash values and duplicates", () => {
  const spec = defineArgs({
    command: "wi-impl tw comment",
    flags: { body: { type: "string" }, limit: { type: "number" }, tag: { type: "string", repeatable: true } },
  });

  test("a string value starting with '-' → MISSING_VALUE with a --flag=<value> hint", () => {
    const e = err(() => spec.parse(["--body", "-item"]));
    expect(e.code).toBe("MISSING_VALUE");
    expect(e.message).toContain("--body=<value>");
    expect(e.message).toContain("--body=-item");
    expect((e.details as any).hint).toBe("--body=<value>");
    expect(spec.parse(["--body=-item"]).flags.body).toBe("-item");
  });

  test("a huge flag-like token is truncated in the message", () => {
    const sql = "--comment\n" + "SELECT 1 ".repeat(200);
    const e = err(() => spec.parse(["--body", sql]));
    expect(e.message.length).toBeLessThan(400);
    const u = err(() => spec.parse([sql]));
    expect(u.code).toBe("UNKNOWN_FLAG");
    expect(u.message.length).toBeLessThan(400);
    expect(u.message).toContain("--flag=<value>");
  });

  test("repeated non-repeatable flag names both values", () => {
    const e = err(() => spec.parse(["--limit", "5", "--limit", "50"]));
    expect(e.code).toBe("DUPLICATE_FLAG");
    expect(e.message).toContain("'5'");
    expect(e.message).toContain("'50'");
    expect((e.details as any).values).toEqual([5, 50]);
    expect(spec.parse(["--tag", "a", "--tag", "b"]).flags.tag).toEqual(["a", "b"]);
  });
});
