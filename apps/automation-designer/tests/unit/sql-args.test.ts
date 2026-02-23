import { describe, expect, test } from "bun:test";
import sqlCommand from "../../commands/sql";

describe("sql command parseArgs", () => {
  test("parses run query", () => {
    const parsed = sqlCommand.parseArgs?.(["run", "select 1"]) as any;
    expect(parsed.action).toBe("run");
    expect(parsed.query).toBe("select 1");
  });

  test("parses run query with db and raw flags", () => {
    const parsed = sqlCommand.parseArgs?.(["run", "select * from users", "--db", "NSM_QA_DB", "--raw"]) as any;
    expect(parsed.action).toBe("run");
    expect(parsed.db).toBe("NSM_QA_DB");
    expect(parsed.raw).toBe(true);
  });

  test("parses db listing subcommand", () => {
    const parsed = sqlCommand.parseArgs?.(["dbs", "--raw"]) as any;
    expect(parsed.action).toBe("dbs");
    expect(parsed.raw).toBe(true);
  });

  test("throws on unknown subcommand", () => {
    try {
      sqlCommand.parseArgs?.(["unknown"]);
      throw new Error("expected parseArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("INVALID_SQL_SUBCOMMAND");
    }
  });

  test("throws when run query is missing", () => {
    try {
      sqlCommand.parseArgs?.(["run"]);
      throw new Error("expected parseArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("MISSING_SQL_QUERY");
    }
  });
});
