// Top-level commands parse argv with core defineArgs: unknown flags, stray
// arguments and missing values are CliErrors (never silently ignored). Parse
// only — none of these commands is executed here.
import { describe, expect, test } from "bun:test";
import cache from "../commands/cache/index";
import envs from "../commands/envs/index";
import onboard from "../commands/onboard/index";
import update from "../commands/update/index";
import { parseConfigArgs } from "../commands/config/args";
import { errorCode as code } from "@belzabar/core/testing";

const ctx = { outputMode: "llm", env: { name: "t" }, warn: () => {} } as any;

describe("config", () => {
  test("subcommands", () => {
    expect(parseConfigArgs(["get"])).toEqual({ action: "get" });
    expect(parseConfigArgs(["edit"])).toEqual({ action: "edit" });
    expect(parseConfigArgs(["token"])).toEqual({ action: "token", refresh: false });
    expect(parseConfigArgs(["token", "--refresh"])).toEqual({ action: "token", refresh: true });
  });
  test("errors", () => {
    expect(code(() => parseConfigArgs([]))).toBe("MISSING_SUBCOMMAND");
    expect(code(() => parseConfigArgs(["tokn"]))).toBe("UNKNOWN_SUBCOMMAND");
    expect(() => parseConfigArgs(["envs"])).toThrow(/wi-impl envs/);
    expect(code(() => parseConfigArgs(["get", "--refresh"]))).toBe("UNKNOWN_FLAG");
    expect(code(() => parseConfigArgs(["token", "extra"]))).toBe("UNEXPECTED_ARGUMENT");
  });
});

describe("cache", () => {
  const parse = (a: string[]) => cache.parseArgs!(a, ctx) as any;
  test("flags", () => {
    expect(parse(["44014c3707d6b6d8ae848839a1c8d1e7", "--type=PAGE"])).toMatchObject({ uuids: ["44014c3707d6b6d8ae848839a1c8d1e7"], type: "PAGE", all: false });
    expect(parse(["-y", "--all"])).toMatchObject({ uuids: [], all: true, yes: true, type: "AUTOMATION" });
  });
  test("errors", () => {
    expect(code(() => parse(["u1", "--type"]))).toBe("MISSING_VALUE");
    expect(code(() => parse(["u1", "--type", "--all"]))).toBe("MISSING_VALUE");
    expect(code(() => parse(["u1", "--bogus"]))).toBe("UNKNOWN_FLAG");
  });
  test("invalidate is a remote write, prune-local is not", () => {
    const writes = cache.writes as (args: any) => boolean;
    expect(writes(parse(["44014c3707d6b6d8ae848839a1c8d1e7"]))).toBe(true);
    expect(writes(parse(["prune-local"]))).toBe(false);
  });
});

describe("update / onboard / envs", () => {
  test("update", () => {
    expect(update.parseArgs!(["--check"], ctx)).toEqual({ check: true, force: false, rollback: false });
    expect(update.parseArgs!(["-f"], ctx)).toEqual({ check: false, force: true, rollback: false });
    expect(update.parseArgs!(["--rollback"], ctx)).toEqual({ check: false, force: false, rollback: true });
    expect(code(() => update.parseArgs!(["--rollback", "--check"], ctx))).toBe("CONFLICTING_FLAGS");
    expect(code(() => update.parseArgs!(["--chek"], ctx))).toBe("UNKNOWN_FLAG");
  });
  test("onboard / envs take no arguments", () => {
    expect(onboard.parseArgs!([], ctx)).toEqual({});
    expect(code(() => onboard.parseArgs!(["--force"], ctx))).toBe("UNKNOWN_FLAG");
    expect(envs.parseArgs!([], ctx)).toBeUndefined();
    expect(code(() => envs.parseArgs!(["x"], ctx))).toBe("UNEXPECTED_ARGUMENT");
  });
  test("local writers are marked", () => {
    for (const c of [update, onboard]) expect((c as any).writesLocal).toBe(true);
  });
});
