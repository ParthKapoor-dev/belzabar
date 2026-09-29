// 7.11: `ad sql explain` — EXPLAIN [ANALYZE] only of statements that pass the
// read-only gate (ANALYZE executes the statement). Plan rows below are the
// live sems-dev answers (testing_db, 2026-09-29).
import { describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import sqlCommand, { readPlan } from "../../commands/sql/index";
import { buildExplainSql, splitExplain } from "../../lib/sql/read-only";

const parse = (argv: string[]) => sqlCommand.parseArgs!(argv, {} as any) as any;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as CliError).code;
  }
  return "no error";
};

const TEXT_ROWS = [
  { "QUERY PLAN": "Index Scan using pg_class_relname_nsp_index on pg_class  (cost=0.28..8.29 rows=1 width=273) (actual time=0.004..0.004 rows=0 loops=1)" },
  { "QUERY PLAN": "  Index Cond: (relname = 'x'::name)" },
  { "QUERY PLAN": "  Buffers: shared hit=2" },
  { "QUERY PLAN": "Planning Time: 16.137 ms" },
  { "QUERY PLAN": "Execution Time: 0.071 ms" },
];
const JSON_ROWS = [
  {
    "QUERY PLAN":
      '[{"Plan":{"Node Type":"Result","Actual Rows":1,"Actual Loops":1},"Planning Time":0.007,"Triggers":[],"Execution Time":0.01}]',
  },
];

describe("sql explain parseArgs", () => {
  test("builds EXPLAIN with the options", () => {
    expect(parse(["explain", "select * from t where a = 'x'"]).query).toBe("EXPLAIN select * from t where a = 'x'");
    expect(parse(["explain", "select 1;", "--analyze", "--buffers", "--format", "json"]).query).toBe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select 1");
    expect(parse(["explain", "with x as (select 1) select * from x", "--analyze"])).toMatchObject({
      action: "explain",
      explain: { analyze: true, buffers: false, format: "text" },
    });
  });

  test("the statement must pass the read-only gate (ANALYZE executes it)", () => {
    expect(code(() => parse(["explain", "delete from t", "--analyze"]))).toBe("SQL_NOT_READ_ONLY");
    expect(code(() => parse(["explain", "with u as (update t set a = 1 returning *) select * from u"]))).toBe("SQL_NOT_READ_ONLY");
    expect(code(() => parse(["explain", "select 1; drop table t"]))).toBe("SQL_NOT_READ_ONLY");
  });

  test("nested EXPLAIN, --buffers without --analyze, bad --format", () => {
    expect(code(() => parse(["explain", "explain analyze select 1"]))).toBe("SQL_EXPLAIN_NESTED");
    expect(code(() => parse(["explain", "select 1", "--buffers"]))).toBe("SQL_EXPLAIN_BUFFERS_NEEDS_ANALYZE");
    expect(code(() => parse(["explain", "select 1", "--format", "xml"]))).toBe("INVALID_VALUE");
  });

  test("explain is a read (not a write)", () => {
    expect((sqlCommand.writes as (a: any) => boolean)({ action: "explain" })).toBe(false);
  });

  test("sql run also accepts EXPLAIN ANALYZE of a read, never of a write", () => {
    expect(parse(["run", "explain analyze select 1"]).action).toBe("run");
    expect(code(() => parse(["run", "explain analyze delete from t"]))).toBe("SQL_NOT_READ_ONLY");
  });
});

describe("readPlan", () => {
  test("text: plan lines + ANALYZE timings", () => {
    const r = readPlan(TEXT_ROWS, "text");
    expect((r.plan as string[]).length).toBe(5);
    expect(r.timing).toEqual({ planningMs: 16.137, executionMs: 0.071 });
  });

  test("json: parsed plan + timings; no timings without ANALYZE", () => {
    const r = readPlan(JSON_ROWS, "json");
    expect((r.plan as any)[0].Plan["Node Type"]).toBe("Result");
    expect(r.timing).toEqual({ planningMs: 0.007, executionMs: 0.01 });
    expect(readPlan([{ "QUERY PLAN": "Result  (cost=0.00..0.01 rows=1 width=4)" }], "text").timing).toBeUndefined();
  });
});

describe("splitExplain / buildExplainSql", () => {
  test("options and inner statement", () => {
    expect(splitExplain("EXPLAIN (ANALYZE false, COSTS) select 1")).toEqual({ analyze: false, inner: "select 1" });
    expect(splitExplain("explain analyse verbose select 1")).toEqual({ analyze: true, inner: "select 1" });
    expect(buildExplainSql(" select 1 ; ")).toBe("EXPLAIN select 1");
  });
});
