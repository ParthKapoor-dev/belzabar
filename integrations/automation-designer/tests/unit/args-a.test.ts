// core/args migration of AD commands (part A): strict parsing regressions
// (AD-29, AD-37, F34) and the changelog/publish --note contract.
import { describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import categories from "../../commands/categories/index";
import category from "../../commands/category/index";
import changelog from "../../commands/changelog/index";
import diff from "../../commands/diff/index";
import exportCmd from "../../commands/export/index";
import find from "../../commands/find/index";
import history from "../../commands/history/index";
import importCmd from "../../commands/import/index";
import publish from "../../commands/publish/index";
import save from "../../commands/save/index";
import create from "../../commands/create/index";

const ctx = {} as any;
const parse = (cmd: any, argv: string[]) => cmd.parseArgs(argv, ctx);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return (e as CliError).code;
  }
  throw new Error("expected a CliError");
}

describe("strict flags (AD-29)", () => {
  test("unknown flags are rejected", () => {
    expect(code(() => parse(exportCmd, ["123", "--outt", "f"]))).toBe("UNKNOWN_FLAG");
    expect(code(() => parse(publish, ["u", "--note", "n", "--bogus"]))).toBe("UNKNOWN_FLAG");
  });

  test("a missing or flag-looking value is MISSING_VALUE", () => {
    expect(code(() => parse(exportCmd, ["123", "--out"]))).toBe("MISSING_VALUE");
    expect(code(() => parse(publish, ["u", "--note", "--yes"]))).toBe("MISSING_VALUE");
    expect(code(() => parse(publish, ["u", "--note="]))).toBe("MISSING_VALUE");
    expect(code(() => parse(diff, ["u", "--from", "x"]))).toBe("INVALID_VALUE");
  });

  test("--v2 is accepted everywhere (AD-37)", () => {
    expect(parse(find, ["--v2", "foo"]).query).toBe("foo");
    expect(parse(categories, ["--v2"])).toEqual({ system: false, user: false });
  });
});

describe("categories (F34)", () => {
  test("--user and --system are exclusive", () => {
    expect(code(() => parse(categories, ["--user", "--system"]))).toBe("CONFLICTING_FLAGS");
    expect(parse(categories, ["--user"])).toEqual({ system: false, user: true });
  });
});

describe("--note", () => {
  test("publish requires --note", () => {
    expect(code(() => parse(publish, ["u"]))).toBe("MISSING_CHANGE_NOTE");
    expect(code(() => parse(publish, []))).toBe("MISSING_UUID");
    expect(parse(publish, ["--note", "  fixed  ", "u", "-y"])).toEqual({
      uuid: "u", note: "fixed", yes: true, noValidate: false, strict: false, dryRunCompile: false, allowPreexisting: false,
    });
    expect(parse(publish, ["u", "--note", "n", "--allow-preexisting", "--no-validate"])).toMatchObject({ allowPreexisting: true, noValidate: true });
    expect(parse(publish, ["u", "--note=inline"]).note).toBe("inline");
  });

  test("changelog --note is optional and marks the command as a write", () => {
    const list = parse(changelog, ["u"]);
    expect(list).toEqual({ uuid: "u", note: undefined, yes: false });
    const add = parse(changelog, ["u", "--note", "hello"]);
    expect(add.note).toBe("hello");
    expect((changelog as any).writes(list)).toBe(false);
    expect((changelog as any).writes(add)).toBe(true);
  });
});

describe("history", () => {
  test("restore parses and is a write", () => {
    const a = parse(history, ["restore", "u", "--version", "3", "--yes"]);
    expect(a).toEqual({ action: "restore", uuid: "u", version: 3, yes: true });
    expect((history as any).writes(a)).toBe(true);
    expect((history as any).writes(parse(history, ["list", "u"]))).toBe(false);
  });

  test("errors keep their codes", () => {
    expect(code(() => parse(history, []))).toBe("INVALID_ACTION");
    expect(code(() => parse(history, ["restor", "u"]))).toBe("INVALID_ACTION");
    expect(code(() => parse(history, ["show"]))).toBe("MISSING_UUID");
    expect(code(() => parse(history, ["restore", "u"]))).toBe("MISSING_VERSION");
    expect(code(() => parse(history, ["diff", "u", "--from", "1"]))).toBe("MISSING_VERSION");
    expect(parse(history, ["diff", "u", "--from", "1", "--to", "2"])).toMatchObject({ v1: 1, v2num: 2 });
  });
});

describe("other writes", () => {
  test("ADW-R6: save/create --dry-run is a read, but --dry-run-compile (executing /chain/test) is a write", () => {
    const w = (cmd: any, argv: string[]) => cmd.writes(parse(cmd, argv));
    expect(w(save, ["ov.json", "--uuid", "u", "--dry-run"])).toBe(false);
    expect(w(save, ["ov.json", "--uuid", "u", "--dry-run", "--dry-run-compile"])).toBe(true);
    expect(w(save, ["ov.json", "--uuid", "u"])).toBe(true);
    expect(w(create, ["--spec", "s.json", "--dry-run"])).toBe(false);
    expect(w(create, ["--spec", "s.json", "--dry-run", "--dry-run-compile"])).toBe(true);
  });

  test("category create / import / publish are writes", () => {
    expect((category as any).writes).toBe(true);
    expect((importCmd as any).writes).toBe(true);
    expect((publish as any).writes).toBe(true);
    expect(parse(category, ["create", "X", "--private", "--description", "d"])).toMatchObject({
      name: "X",
      isPrivate: true,
      description: "d",
    });
    expect(code(() => parse(category, ["delete", "X"]))).toBe("INVALID_ACTION");
  });
});

describe("find / diff", () => {
  test("find list rejects a query; limit is bounded", () => {
    expect(code(() => parse(find, ["list", "x"]))).toBe("LIST_DOES_NOT_ACCEPT_QUERY");
    expect(code(() => parse(find, ["x", "--limit", "500"]))).toBe("INVALID_VALUE");
  });

  test("diff: --from-env implies cross-env; --raw disables clean", () => {
    const a = parse(diff, ["u", "--from-env", "a", "--to-env", "b", "--raw"]);
    expect(a).toMatchObject({ mode: "cross-env", clean: false, editor: "zed", noEditor: false });
  });
});
