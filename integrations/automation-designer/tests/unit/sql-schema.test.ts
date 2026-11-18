// E9: `ad sql tables` / `ad sql describe <table>` answer the schema questions
// agents asked with 170+ hand-written information_schema queries (12 of them
// on guessed names). A missing table names the similar ones.
import { afterEach, describe, expect, test } from "bun:test";
import { errorCode as code, fakeFetch, runCommand, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import sqlCommand from "../../commands/sql";
import { resetExecutableCategoryCache } from "../../lib/sql/api";
import { checkReadOnlySql, findParameterMarker } from "../../lib/sql/read-only";
import { buildDescribeQuery, buildSimilarTablesQuery, buildTablesQuery, parseTableName, readColumns } from "../../lib/sql/schema";

const parse = (argv: string[]) => sqlCommand.parseArgs!(argv, {} as any) as any;

describe("queries", () => {
  test("every built query passes the read and parameter gates", () => {
    for (const q of [
      buildTablesQuery(),
      buildTablesQuery({ schema: "public", like: "app" }),
      buildDescribeQuery("application"),
      buildDescribeQuery("t", "s"),
      buildSimilarTablesQuery("prog_types"),
    ]) {
      expect(checkReadOnlySql(q).reason).toBeUndefined();
      expect(findParameterMarker(q)).toBeUndefined();
    }
  });

  test("names and patterns are quoted literals", () => {
    expect(buildDescribeQuery("o'neil")).toContain("c.table_name = 'o''neil'");
    expect(buildTablesQuery({ like: "app" })).toContain("ilike '%app%'");
    expect(buildTablesQuery({ like: "app%" })).toContain("ilike 'app%'");
    expect(buildTablesQuery()).toContain("not in ('pg_catalog', 'information_schema')");
    expect(buildTablesQuery({ schema: "information_schema" })).toContain("table_schema = 'information_schema'");
  });

  test("parseTableName", () => {
    expect(parseTableName("application")).toEqual({ table: "application" });
    expect(parseTableName("public.application")).toEqual({ schema: "public", table: "application" });
    expect(parseTableName('"my.schema"."T"')).toEqual({ schema: "my.schema", table: "T" });
    expect(code(() => parseTableName("a.b.c"))).toBe("SQL_INVALID_TABLE_NAME");
  });

  test("readColumns: booleans from YES/NO, grouped by schema", () => {
    const cols = readColumns([
      { schema: "public", name: "id", type: "integer", nullable: "NO", default_value: "nextval('s')", primary_key: "YES" },
      { schema: "public", name: "arr", type: "_int4", nullable: "YES", default_value: null, primary_key: "NO" },
    ]);
    expect(cols.get("public")).toEqual([
      { name: "id", type: "integer", nullable: false, default: "nextval('s')", primaryKey: true },
      { name: "arr", type: "_int4", nullable: true, default: null, primaryKey: false },
    ]);
  });

  test("parseArgs", () => {
    expect(parse(["tables", "--like", "app"])).toMatchObject({ action: "tables", schema: { like: "app" } });
    expect(parse(["describe", "public.t"])).toMatchObject({ action: "describe", schema: { schema: "public", table: "t" } });
    expect(code(() => parse(["describe"]))).toBe("MISSING_SQL_TABLE");
    expect((sqlCommand.writes as (a: any) => boolean)({ action: "describe" })).toBe(false);
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
const rows = (r: unknown[]) => ({ services: [{ outputs: [{ testResult: JSON.stringify(r) }] }], executionStatus: { failed: false, statusCode: 200 } });

function install(answers: unknown[]) {
  cfg = withTempEnvConfig({ envs: { dev: { url: "https://dev.example.test" } }, activeEnv: "dev" });
  ff = fakeFetch([
    { method: "GET", url: "/rest/api/automation-systems/db_service/auth", response: [{ id: 215, nickname: "testing_db" }] },
    { method: "GET", url: "/rest/api/automation-systems/db_service/automation-apis/select", response: { id: 19, methodUUID: "tpl" } },
    { method: "GET", url: "/rest/api/automation/chain/tpl", response: TEMPLATE },
    { method: "GET", url: /chain\/category/, response: [{ id: 7, name: "Helpers", accessMode: "PUBLIC" }] },
    ...answers.map((response) => ({ method: "POST", url: "/rest/api/automation/chain/test", once: true, response })),
  ]).install();
}
const run = (argv: string[]) => runCommand(sqlCommand, [...argv, "--db", "testing_db"], { commandName: "sql", env: "dev" });

describe("execute", () => {
  test("tables", async () => {
    install([rows([{ schema: "public", name: "application", type: "BASE TABLE" }])]);
    const r = await run(["tables"]);
    expect(r.envelope?.data).toMatchObject({ action: "tables", count: 1, tables: [{ schema: "public", name: "application", type: "BASE TABLE" }] });
  });

  test("describe", async () => {
    install([rows([{ schema: "public", name: "id", type: "integer", nullable: "NO", default_value: null, primary_key: "YES" }])]);
    const r = await run(["describe", "application"]);
    expect(r.envelope?.data).toMatchObject({ action: "describe", schema: "public", table: "application", columns: [{ name: "id", primaryKey: true }] });
  });

  test("a missing table names the similar ones", async () => {
    install([rows([]), rows([{ schema: "public", name: "program_types" }])]);
    const r = await run(["describe", "prog_types"]);
    expect(r.envelope?.error?.code).toBe("SQL_TABLE_NOT_FOUND");
    expect(r.envelope?.error?.message).toContain("Similar: public.program_types.");
  });

  test("a name in several schemas asks for schema.table", async () => {
    install([rows([{ schema: "a", name: "id" }, { schema: "b", name: "id" }])]);
    const r = await run(["describe", "t"]);
    expect(r.envelope?.error?.code).toBe("SQL_TABLE_AMBIGUOUS");
    expect(r.envelope?.error?.message).toContain("a, b");
  });
});
