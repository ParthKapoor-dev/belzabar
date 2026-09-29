import { describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { checkReadOnlySql } from "../../lib/sql/read-only";
import sqlCommand from "../../commands/sql";

const ALLOWED: string[] = [
  "select 1",
  "SELECT * FROM users WHERE id = 5;",
  "  select 1 ;  ",
  "with x as (select 1 as a) select * from x",
  "WITH RECURSIVE t(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM t WHERE n < 5) SELECT sum(n) FROM t",
  "values (1), (2)",
  "explain select * from t",
  // EXPLAIN [ANALYZE] is judged by its inner statement.
  "explain analyze select * from t",
  "EXPLAIN ANALYZE VERBOSE with x as (select 1) select * from x",
  "explain (analyze, buffers, format json) select * from t where a = 'delete'",
  "explain (analyze false) select 1",
  "table users",
  "show search_path",
  "select 'delete from t; drop table x' as s",
  "select \"update\", \"insert\" from t",
  "select $$ insert into x $$ as body",
  "select $tag$ ; delete $tag$",
  "select 1 -- delete from t\n",
  "/* drop table x; */ select 1",
  "select E'it\\'s ; update' as s",
  "select updated_at, created_by, deleted from t",
];

const REFUSED: Array<[string, string]> = [
  ["delete from t where v = 'd'", "starts with 'delete'"],
  ["delete from t returning id", "starts with 'delete'"],
  ["with x as (delete from t returning *) select * from x", "DELETE"],
  ["with x as (insert into t values (1) returning id) select * from x", "INSERT"],
  ["WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT count(*) FROM u", "UPDATE"],
  ["create table belz_tst_x (id int)", "starts with 'create'"],
  ["drop table t", "starts with 'drop'"],
  ["truncate t", "starts with 'truncate'"],
  ["select 1; delete from t", "multiple statements"],
  ["select 1; select 2", "multiple statements"],
  ["/* hide */ delete from t", "starts with 'delete'"],
  ["-- select\ndelete from t", "starts with 'delete'"],
  ["select 1 /* ; */ ; update t set a = 1", "multiple statements"],
  ["explain analyze delete from t", "ANALYZE"],
  ["explain (analyze) delete from t", "EXPLAIN ANALYZE of a statement that starts with 'delete'"],
  ["explain (analyze, format json) with u as (update t set a = 1 returning *) select * from u", "UPDATE"],
  ["explain update t set a = 1", "starts with 'update'"],
  ["explain explain select 1", "starts with 'explain'"],
  ["explain (analyze, drop) select 1", "unknown EXPLAIN option"],
  ["explain (analyze select 1", "unclosed"],
  ["explain analyze", "without a statement"],
  ["explain select * from t; delete from t", "multiple statements"],
  ["select * into newtab from t", "INTO"],
  ["select * from t for update", "UPDATE"],
  ["select 'unterminated", "unterminated"],
  ["/* unterminated select 1", "unterminated"],
  ["", "empty"],
  ["  ;  ", "empty"],
  ["merge into t using s on true when matched then delete", "starts with 'merge'"],
  ["do $$ begin delete from t; end $$", "starts with 'do'"],
  ["call proc()", "starts with 'call'"],
  // SpEL is evaluated server-side before the DB runs the query, even inside literals.
  ["select 1 as x #{'; delete from t'}", "SpEL"],
  ["select '#{1+1}' as x", "SpEL"],
  ["select #{'current_database()'} as x", "SpEL"],
  ["select 1 -- #{T(java.lang.Runtime).getRuntime()}", "SpEL"],
  ["select $$ #{x} $$", "SpEL"],
];

describe("checkReadOnlySql", () => {
  for (const q of ALLOWED) {
    test(`allows: ${JSON.stringify(q)}`, () => {
      const v = checkReadOnlySql(q);
      expect(v.reason).toBeUndefined();
      expect(v.ok).toBe(true);
    });
  }
  for (const [q, reason] of REFUSED) {
    test(`refuses: ${JSON.stringify(q)}`, () => {
      const v = checkReadOnlySql(q);
      expect(v.ok).toBe(false);
      expect(v.reason).toContain(reason);
    });
  }
});

describe("sql run parseArgs gate", () => {
  test("refuses SpEL in run and explain before any network call", () => {
    for (const argv of [["run", "select 1 as x #{'; delete from t'}"], ["explain", "select '#{1+1}'"]]) {
      try {
        sqlCommand.parseArgs?.(argv, {} as any);
        throw new Error("expected refusal");
      } catch (err) {
        expect((err as CliError).code).toBe("SQL_NOT_READ_ONLY");
      }
    }
  });

  test("refuses DML with SQL_NOT_READ_ONLY before any network call", () => {
    try {
      sqlCommand.parseArgs?.(["run", "delete from t returning id"], {} as any);
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("SQL_NOT_READ_ONLY");
      expect((err as CliError).message).toContain("sql update");
    }
  });

  test("write subcommands parse --yes", () => {
    for (const action of ["update", "insert", "modify"]) {
      const parsed = sqlCommand.parseArgs?.([action, "x", "--yes"], {} as any) as any;
      expect(parsed.yes).toBe(true);
      expect(parsed.query).toBe("x");
      const noYes = sqlCommand.parseArgs?.([action, "x"], {} as any) as any;
      expect(noYes.yes).toBe(false);
    }
  });
});
