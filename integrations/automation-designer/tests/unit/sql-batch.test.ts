// E2 / E6: SQL from `--file <path>` or stdin (`-`), with no argument-length
// limit, and several `;`-separated statements run in one call (one result
// each) instead of one ~3 s process per statement.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CliError } from "@belzabar/core";
import { errorCode as code, fakeFetch, runCommand, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import sqlCommand from "../../commands/sql";
import { resetExecutableCategoryCache } from "../../lib/sql/api";
import { splitSqlStatements } from "../../lib/sql/read-only";
import { readSqlSource } from "../../lib/sql/source";

const parse = (argv: string[]) => sqlCommand.parseArgs!(argv, {} as any) as any;
const dir = mkdtempSync(join(tmpdir(), "wi-impl-sql-batch-"));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

describe("splitSqlStatements", () => {
  test("splits at ; outside literals and comments, drops empty pieces", () => {
    expect(splitSqlStatements("select 1; select ';' as s;\n-- note\n; select $$a;b$$")).toEqual(["select 1", "select ';' as s", "select $$a;b$$"]);
    expect(splitSqlStatements("  -- only a comment\n ; ")).toEqual([]);
    expect(splitSqlStatements("select 1 /* ; */")).toEqual(["select 1 /* ; */"]);
  });
});

describe("readSqlSource", () => {
  const readers = { file: (p: string) => `FILE ${p}`, stdin: () => "STDIN" };
  test("argument, --file, '-' and --file - (stdin)", () => {
    expect(readSqlSource("run", "select 1", undefined, readers)).toBe("select 1");
    expect(readSqlSource("run", undefined, "q.sql", readers)).toBe("FILE q.sql");
    expect(readSqlSource("run", "-", undefined, readers)).toBe("STDIN");
    expect(readSqlSource("run", undefined, "-", readers)).toBe("STDIN");
  });
  test("neither, both, unreadable", () => {
    expect(code(() => readSqlSource("run", undefined, undefined, readers))).toBe("MISSING_SQL_QUERY");
    expect(code(() => readSqlSource("run", "select 1", "q.sql", readers))).toBe("SQL_QUERY_AND_FILE");
    expect(code(() => readSqlSource("run", undefined, join(dir, "missing.sql")))).toBe("SQL_FILE_UNREADABLE");
  });
});

describe("parseArgs", () => {
  test("--file with one statement keeps the single-statement shape", () => {
    expect(parse(["run", "--file", file("one.sql", "select 1;\n")])).toMatchObject({ action: "run", query: "select 1" });
    expect(parse(["explain", "--file", file("ex.sql", "select 1")]).query).toBe("EXPLAIN select 1");
    expect(parse(["update", "--file", file("up.sql", "update t set a = 1"), "--yes"])).toMatchObject({ action: "update", query: "update t set a = 1" });
  });

  test("a long statement from a file (no argument-length limit)", () => {
    const big = `select * from (values ${Array.from({ length: 4000 }, (_, i) => `(${i}, 'v${i}')`).join(", ")}) v(a, b)`;
    expect(parse(["run", "--file", file("big.sql", big)]).query.length).toBe(big.length);
  });

  test("several statements: statements[], each gated, the error names the statement", () => {
    expect(parse(["run", "--file", file("many.sql", "select 1;\nselect 2;\nselect 3;")])).toMatchObject({
      action: "run",
      statements: ["select 1", "select 2", "select 3"],
    });
    expect(parse(["run", "select 1; select 2"]).statements).toHaveLength(2);
    let err: CliError | undefined;
    try {
      parse(["run", "select 1; delete from t"]);
    } catch (e) {
      err = e as CliError;
    }
    expect(err?.code).toBe("SQL_NOT_READ_ONLY");
    expect(err?.message).toStartWith("Statement 2 of 2:");
    expect(code(() => parse(["update", "update t set a = 1; insert into t values (1)", "--yes"]))).toBe("SQL_WRONG_STATEMENT");
    expect(parse(["insert", "insert into t values (1); insert into t values (2)", "--yes"]).statements).toHaveLength(2);
  });

  test("explain takes one statement only", () => {
    expect(code(() => parse(["explain", "select 1; select 2"]))).toBe("SQL_NOT_READ_ONLY");
  });

  test("an argument and --file together, or neither", () => {
    expect(code(() => parse(["run", "select 1", "--file", file("x.sql", "select 2")]))).toBe("SQL_QUERY_AND_FILE");
    expect(code(() => parse(["run"]))).toBe("MISSING_SQL_QUERY");
    expect(code(() => parse(["update", "--yes"]))).toBe("MISSING_SQL_QUERY");
  });
});

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = cfg = null;
  resetExecutableCategoryCache();
});

const TEMPLATE = {
  id: 1,
  uuid: "tpl",
  category: { id: 7 },
  jsonDefinition: JSON.stringify({ services: [{ automationApiId: 19, mappings: [{ encodingType: "BASE_64", value: "" }] }] }),
};
const rowsResponse = (rows: unknown[]) => ({
  services: [{ executionStatus: { failed: false }, outputs: [{ testResult: JSON.stringify(rows) }] }],
  executionStatus: { failed: false, statusCode: 200, totalExecutionTime: { time: 5, unit: "milliseconds" } },
});
const countResponse = (n: number) => ({
  services: [{ executionStatus: { failed: false }, outputs: [{ testResult: String(n) }] }],
  executionStatus: { failed: false, statusCode: 200 },
});
const failed = (databaseError: string) => {
  const message = JSON.stringify({ result: { status: 400, databaseError } });
  return {
    services: [{ executionStatus: { failed: true, message }, outputs: [] }],
    executionStatus: { failed: true, statusCode: 400, message, errorMessage: message },
  };
};

/** The statement a POST carries (base64 in the template's SQL mapping). */
function postedQuery(req: { body: string | null }): string {
  const entries = JSON.parse(req.body ?? "[]") as Array<[string, string]>;
  const payload = JSON.parse(entries.find(([k]) => k === "body")![1]);
  const value = JSON.parse(payload.jsonDefinition).services[0].mappings[0].value as string;
  return Buffer.from(value, "base64").toString("utf8");
}

/** Reads run concurrently: answer each POST by its statement. */
const byQuery = (answers: Record<string, unknown>) => (req: { body: string | null }) => answers[postedQuery(req)];

function install(operation: string, posts: unknown[] | ((req: { body: string | null }) => unknown)) {
  cfg = withTempEnvConfig({ envs: { dev: { url: "https://dev.example.test" } }, activeEnv: "dev" });
  ff = fakeFetch([
    { method: "GET", url: "/rest/api/automation-systems/db_service/auth", response: [{ id: 215, nickname: "testing_db" }] },
    { method: "GET", url: `/rest/api/automation-systems/db_service/automation-apis/${operation}`, response: { id: 19, methodUUID: "tpl" } },
    { method: "GET", url: "/rest/api/automation/chain/tpl", response: TEMPLATE },
    { method: "GET", url: /chain\/category/, response: [{ id: 7, name: "Helpers", accessMode: "PUBLIC" }] },
    ...(typeof posts === "function"
      ? [{ method: "POST", url: "/rest/api/automation/chain/test", response: posts }]
      : posts.map((response) => ({ method: "POST", url: "/rest/api/automation/chain/test", once: true, response }))),
  ]).install();
}
const posts = () => ff!.requests.filter((r) => r.method === "POST").length;
const gets = (path: string) => ff!.requests.filter((r) => r.method === "GET" && new URL(r.url).pathname === path).length;

describe("execute: one call, one result per statement", () => {
  test("reads: all run, the context loads once", async () => {
    install("select", byQuery({ "select 1": rowsResponse([{ n: 1 }]), "select 2": rowsResponse([{ n: 2 }]), "select 3": rowsResponse([]) }));
    const r = await runCommand(sqlCommand, ["run", "select 1; select 2; select 3", "--db", "testing_db"], { commandName: "sql", env: "dev" });
    expect(r.envelope?.ok).toBe(true);
    const data = r.envelope!.data as any;
    expect(data).toMatchObject({ action: "run", batch: true, statementCount: 3, okCount: 3, failedCount: 0 });
    expect(data.results.map((x: any) => x.rows)).toEqual([[{ n: 1 }], [{ n: 2 }], []]);
    expect(data.results[0]).toMatchObject({ index: 1, query: "select 1", ok: true, rowCount: 1 });
    expect(posts()).toBe(3);
    expect(gets("/rest/api/automation/chain/tpl")).toBe(1);
  });

  test("reads: up to 4 in flight, results stay in input order", async () => {
    let inFlight = 0;
    let peak = 0;
    install("select", async (req) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return rowsResponse([{ q: postedQuery(req) }]);
    });
    const sql = Array.from({ length: 10 }, (_, i) => `select ${i}`).join(";");
    const r = await runCommand(sqlCommand, ["run", sql, "--db", "testing_db"], { commandName: "sql", env: "dev" });
    expect((r.envelope!.data as any).results.map((x: any) => x.rows[0].q)).toEqual(Array.from({ length: 10 }, (_, i) => `select ${i}`));
    expect(peak).toBe(4);
  });

  test("reads: a failed statement does not stop the others; SQL_BATCH_FAILED keeps every result", async () => {
    install(
      "select",
      byQuery({
        "select 1": rowsResponse([{ n: 1 }]),
        "select x": failed('org.postgresql.util.PSQLException: ERROR: column "x" does not exist'),
        "select 3": rowsResponse([{ n: 3 }]),
      }),
    );
    const r = await runCommand(sqlCommand, ["run", "select 1; select x; select 3", "--db", "testing_db"], { commandName: "sql", env: "dev" });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("SQL_BATCH_FAILED");
    expect(r.envelope?.error?.message).toContain('Statement 2 of 3 failed: SQL query execution failed: column "x" does not exist');
    const data = r.envelope!.data as any;
    expect(data.results.map((x: any) => x.ok)).toEqual([true, false, true]);
    expect(data.results[1].error.code).toBe("SQL_QUERY_FAILED");
    expect(data.results[1].error.details).not.toHaveProperty("query");
    expect(posts()).toBe(3);
  });

  test("writes: stop at the first failure, the rest are not sent", async () => {
    install("update", [countResponse(1), failed("org.postgresql.util.PSQLException: ERROR: boom"), countResponse(1)]);
    const r = await runCommand(
      sqlCommand,
      ["update", "--file", file("w.sql", "update t set a = 1 where id = 1;\nupdate t set a = x;\ndelete from t where id = 3;"), "--db", "testing_db", "--yes"],
      { commandName: "sql", env: "dev" },
    );
    expect(r.envelope?.error?.code).toBe("SQL_BATCH_FAILED");
    expect(r.envelope?.error?.message).toContain("(1 later statement not run)");
    const data = r.envelope!.data as any;
    expect(data.results.map((x: any) => [x.ok, x.rowsAffected, x.notRun])).toEqual([
      [true, 1, undefined],
      [false, undefined, undefined],
      [false, undefined, true],
    ]);
    expect(posts()).toBe(2);
    // K17: each sent write says when it was sent; the not-run one does not
    expect(data.results[0].executedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(data.results[1].executedAt).toBeDefined();
    expect(data.results[2].executedAt).toBeUndefined();
  });

  // K17: no transaction time comes back, so the client stamps the send.
  test("single update / insert / modify: executedAt (ISO UTC, between before and after the call); reads have none", async () => {
    for (const [op, argv, response] of [
      ["update", ["update", "update t set a = 1", "--db", "testing_db", "--yes"], countResponse(2)],
      ["insert", ["insert", "insert into t values (1)", "--db", "testing_db", "--yes"], countResponse(1)],
      ["modify", ["modify", "create table t (a int)", "--db", "testing_db", "--yes"], countResponse(0)],
    ] as const) {
      install(op, [response]);
      const before = Date.now();
      const r = await runCommand(sqlCommand, [...argv], { commandName: "sql", env: "dev" });
      const after = Date.now();
      expect(r.envelope?.ok).toBe(true);
      const at = (r.envelope!.data as any).executedAt as string;
      expect(at).toMatch(/Z$/);
      expect(Date.parse(at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(at)).toBeLessThanOrEqual(after);
      ff?.restore();
      cfg?.restore();
      ff = cfg = null;
      resetExecutableCategoryCache();
    }
    install("select", [rowsResponse([{ n: 1 }])]);
    const read = await runCommand(sqlCommand, ["run", "select 1", "--db", "testing_db"], { commandName: "sql", env: "dev" });
    expect((read.envelope!.data as any).executedAt).toBeUndefined();
  });
});
