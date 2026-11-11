// `ad sql update|insert|modify` check the statement before sending it. A flag
// taken as the statement ("--yes": `--` starts a SQL comment) ran as an empty
// statement and was reported as success; `modify "UPDATE …"` went through too.
import { describe, expect, test } from "bun:test";
import { errorCode as code } from "@belzabar/core/testing";
import sqlCommand from "../../commands/sql/index";
import { checkWriteSql } from "../../lib/sql/read-only";
import { executeSqlModify } from "../../lib/sql/executor";

const parse = (argv: string[]) => sqlCommand.parseArgs!(argv, {} as any) as any;

describe("write statement gate", () => {
  test("empty and comment-only statements are refused", () => {
    expect(code(() => parse(["modify", "--yes", "--", "--yes"]))).toBe("SQL_EMPTY_STATEMENT");
    expect(code(() => parse(["update", "  ;  "]))).toBe("SQL_EMPTY_STATEMENT");
    expect(code(() => parse(["insert", "/* nothing */"]))).toBe("SQL_EMPTY_STATEMENT");
  });

  test("each subcommand takes only its own statements", () => {
    expect(code(() => parse(["modify", "UPDATE t SET a = 1"]))).toBe("SQL_WRONG_STATEMENT");
    expect(code(() => parse(["update", "ALTER TABLE t ADD COLUMN g integer"]))).toBe("SQL_WRONG_STATEMENT");
    expect(code(() => parse(["update", "INSERT INTO t VALUES (1)"]))).toBe("SQL_WRONG_STATEMENT");
    expect(code(() => parse(["insert", "DELETE FROM t"]))).toBe("SQL_WRONG_STATEMENT");
    expect(code(() => parse(["update", "select 1"]))).toBe("SQL_WRONG_STATEMENT");
    expect(code(() => parse(["modify", "with x as (select 1) delete from t"]))).toBe("SQL_WRONG_STATEMENT");
  });

  test("the right statements pass, comments and CTEs included", () => {
    expect(parse(["modify", "-- add grade\nALTER TABLE t ADD COLUMN grade integer"]).action).toBe("modify");
    expect(parse(["update", "delete from t where id = 1;"]).action).toBe("update");
    expect(parse(["update", "with x as (select 1) update t set a = 1"]).action).toBe("update");
    expect(parse(["insert", "/* seed */ INSERT INTO t (a) VALUES ('update') RETURNING id"]).action).toBe("insert");
    for (const ddl of ["create index i on t(a)", "drop table t", "truncate t", "comment on table t is 'x'", "grant select on t to r"]) {
      expect(checkWriteSql(ddl, "modify")).toBeUndefined();
    }
  });

  test("a keyword inside a literal or comment does not count", () => {
    expect(checkWriteSql("'update' -- update", "update")).toMatch(/^starts with/);
    expect(checkWriteSql("/* alter */ select 1", "modify")).toMatch(/not DDL/);
  });

  test("the executor refuses too (the TUI calls it directly), before any request", async () => {
    let err: any;
    try {
      await executeSqlModify({ query: "-- yes", database: { id: 1, nickname: "db" } as any, context: {} as any });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("SQL_EMPTY_STATEMENT");
  });
});
