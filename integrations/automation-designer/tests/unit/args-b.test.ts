// defineArgs migration: run, run-suites, save, save-suite, services, show-code,
// sql, state, test, test-case, test-cases, test-report, trace.
import { describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import saveCmd from "../../commands/save";
import saveSuiteCmd from "../../commands/save-suite";
import testCmd from "../../commands/test";
import testCaseCmd from "../../commands/test-case";
import sqlCmd from "../../commands/sql";
import runCmd from "../../commands/run";
import servicesCmd from "../../commands/services";
import showCodeCmd from "../../commands/show-code";
import traceCmd from "../../commands/trace";
import stateCmd from "../../commands/state";

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

describe("save (AD-29)", () => {
  test("--uuid followed by a flag is MISSING_VALUE, not uuid='--yes'", () => {
    expect(code(() => parse(saveCmd, ["f.json", "--uuid", "--yes"]))).toBe("MISSING_VALUE");
  });
  test("parses file, --uuid, -y", () => {
    expect(parse(saveCmd, ["f.json", "--uuid", "abc", "-y"])).toEqual({
      filePath: "f.json", uuid: "abc", yes: true, noValidate: false, strict: false, dryRunCompile: false,
      sqlFiles: [], codeFiles: [], dryRun: false,
    });
    expect(parse(saveCmd, ["f.json", "--uuid", "abc", "--no-validate", "--strict", "--dry-run-compile"])).toMatchObject({
      noValidate: true, strict: true, dryRunCompile: true,
    });
    expect(code(() => parse(saveCmd, ["f.json"]))).toBe("MISSING_UUID");
  });
  test("missing file / unknown flag", () => {
    expect(code(() => parse(saveCmd, ["--uuid", "abc"]))).toBe("MISSING_FILE");
    // Stage 7.2: the file is optional when --sql-file / --code-file carry the change.
    expect(parse(saveCmd, ["--uuid", "abc", "--sql-file", "2=q.sql", "--sql-file", "3=r.sql", "--code-file", "1=c.js"])).toMatchObject({
      filePath: null, sqlFiles: ["2=q.sql", "3=r.sql"], codeFiles: ["1=c.js"],
    });
    expect(code(() => parse(saveCmd, ["f.json", "--uid", "x"]))).toBe("UNKNOWN_FLAG");
  });
  test("is a write command (except --dry-run)", () => {
    const writes = saveCmd.writes as (a: unknown) => boolean;
    expect(writes(parse(saveCmd, ["f.json", "--uuid", "abc"]))).toBe(true);
    expect(writes(parse(saveCmd, ["f.json", "--uuid", "abc", "--dry-run"]))).toBe(false);
  });
});

describe("test (AD-15, CORE-7)", () => {
  test("--verbose and -v are command flags", () => {
    expect(parse(testCmd, ["u", "--verbose"]).verbose).toBe(true);
    expect(parse(testCmd, ["u", "-v"]).verbose).toBe(true);
    expect(parse(testCmd, ["u"]).verbose).toBe(false);
  });
  test("--force is a hidden, deprecated no-op (accepted so old scripts keep working)", () => {
    expect(parse(testCmd, ["u", "--force"]).force).toBe(true);
    expect(parse(testCmd, ["u"]).force).toBe(false);
  });
  test("--inputs needs a value", () => {
    expect(parse(testCmd, ["u", "--inputs", "i.json"]).inputsFile).toBe("i.json");
    expect(code(() => parse(testCmd, ["u", "--inputs"]))).toBe("MISSING_VALUE");
  });
});

describe("test-case subcommands", () => {
  test("routes actions and positionals", () => {
    expect(parse(testCaseCmd, ["update", "u", "tc1", "--file", "f.json", "--yes"])).toEqual({
      action: "update", chainUuid: "u", testCaseId: "tc1", filePath: "f.json", yes: true,
    });
    expect(parse(testCaseCmd, ["delete-suite", "s1"])).toEqual({ action: "delete-suite", testSuiteId: "s1", yes: false });
    expect(parse(testCaseCmd, ["list", "u"]).chainUuid).toBe("u");
  });
  test("errors keep their codes", () => {
    expect(code(() => parse(testCaseCmd, []))).toBe("MISSING_ACTION");
    expect(code(() => parse(testCaseCmd, ["frob"]))).toBe("INVALID_ACTION");
    expect(code(() => parse(testCaseCmd, ["create", "u"]))).toBe("MISSING_FILE");
    expect(code(() => parse(testCaseCmd, ["update", "u"]))).toBe("MISSING_TC_ID");
    expect(code(() => parse(testCaseCmd, ["list"]))).toBe("MISSING_UUID");
  });
  test("writes on every action except list", () => {
    const writes = testCaseCmd.writes as (a: any) => boolean;
    expect(writes({ action: "list" })).toBe(false);
    for (const action of ["create", "update", "delete", "bulk", "run-suite", "delete-suite"]) {
      expect(writes({ action })).toBe(true);
    }
  });
});

describe("sql", () => {
  test("--db flag-looking value is MISSING_VALUE; --db= works", () => {
    expect(code(() => parse(sqlCmd, ["run", "select 1", "--db", "--raw"]))).toBe("MISSING_VALUE");
    expect(parse(sqlCmd, ["run", "select 1", "--db=X"]).db).toBe("X");
  });
  test("--yes is not accepted on run; is on writes", () => {
    expect(code(() => parse(sqlCmd, ["run", "select 1", "--yes"]))).toBe("UNKNOWN_FLAG");
    expect(parse(sqlCmd, ["insert", "insert into t values (1)", "-y"]).yes).toBe(true);
  });
  test("an unquoted multi-word query is refused", () => {
    expect(code(() => parse(sqlCmd, ["run", "select", "1"]))).toBe("UNEXPECTED_ARGUMENT");
  });
  test("writes only for update/insert/modify", () => {
    const writes = sqlCmd.writes as (a: any) => boolean;
    expect(writes({ action: "run" })).toBe(false);
    expect(writes({ action: "update" })).toBe(true);
    expect(writes({ action: "modify" })).toBe(true);
  });
  test("tui --mode validated", () => {
    expect(code(() => parse(sqlCmd, ["tui", "--mode", "drop"]))).toBe("SQL_TUI_INVALID_MODE");
  });
});

describe("other commands", () => {
  test("save-suite --name is required", () => {
    expect(code(() => parse(saveSuiteCmd, ["u"]))).toBe("MISSING_SUITE_NAME");
    expect(parse(saveSuiteCmd, ["u", "--name", "n", "--inputs", "i.json"])).toEqual({
      uuid: "u", suiteName: "n", inputsFile: "i.json",
    });
  });
  test("run takes id + optional payload", () => {
    expect(parse(runCmd, ["p", "{}", "--stream"])).toEqual({ publishedId: "p", payloadArg: "{}", raw: false, stream: true });
    expect(code(() => parse(runCmd, []))).toBe("MISSING_PUBLISHED_ID");
  });
  test("services --search requires a value (F34)", () => {
    expect(code(() => parse(servicesCmd, ["--search"]))).toBe("MISSING_VALUE");
    expect(parse(servicesCmd, ["--search", "redis", "--internal"])).toEqual({ all: false, internal: true, search: "redis", fields: { mode: "default" } });
  });
  test("show-code --step validates; --service-detail alias", () => {
    expect(code(() => parse(showCodeCmd, ["4bf56e008eabe4010508af439a15ecfb", "--step", "x"]))).toBe("INVALID_VALUE");
    expect(parse(showCodeCmd, ["4bf56e008eabe4010508af439a15ecfb", "--service-detail", "3"]).step).toBe(3);
  });
  test("trace --spine: no hard-coded default (the active env is used, AD-25); --envs splits", () => {
    expect(parse(traceCmd, ["u"]).spineEnv).toBeUndefined();
    expect(parse(traceCmd, ["u", "--spine", "sems-dev"]).spineEnv).toBe("sems-dev");
    expect(parse(traceCmd, ["u", "--envs", "sems-qa, sems-uat"]).envs).toEqual(["sems-qa", "sems-uat"]);
  });
  test("state rejects unknown flags", () => {
    expect(code(() => parse(stateCmd, ["u", "--bogus"]))).toBe("UNKNOWN_FLAG");
  });
});
