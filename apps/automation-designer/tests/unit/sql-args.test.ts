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

  test("parses tui args", () => {
    const parsed = sqlCommand.parseArgs?.([
      "tui",
      "--db",
      "NSM_QA_DB",
      "--format",
      "json",
      "--timing",
      "--page-size",
      "25",
      "--no-history",
    ]) as any;

    expect(parsed.action).toBe("tui");
    expect(parsed.tui.db).toBe("NSM_QA_DB");
    expect(parsed.tui.format).toBe("json");
    expect(parsed.tui.timing).toBe(true);
    expect(parsed.tui.pageSize).toBe(25);
    expect(parsed.tui.history).toBe(false);
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

  test("throws on invalid tui format", () => {
    try {
      sqlCommand.parseArgs?.(["tui", "--format", "xml"]);
      throw new Error("expected parseArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("SQL_TUI_INVALID_FORMAT");
    }
  });

  test("throws on invalid tui page size", () => {
    try {
      sqlCommand.parseArgs?.(["tui", "--page-size", "0"]);
      throw new Error("expected parseArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("SQL_TUI_INVALID_PAGE_SIZE");
    }
  });
});
