import { describe, expect, test } from "bun:test";
import type { CommandContext } from "@belzabar/core";
import sqlCommand from "../../commands/sql";

// sql parseArgs ignores the context.
const parse = (argv: string[]) => sqlCommand.parseArgs!(argv, {} as CommandContext);

describe("sql command parseArgs", () => {
  test("parses run query", () => {
    const parsed = parse(["run", "select 1"]) as any;
    expect(parsed.action).toBe("run");
    expect(parsed.query).toBe("select 1");
  });

  test("parses run query with db and raw flags", () => {
    const parsed = parse(["run", "select * from users", "--db", "NSM_QA_DB", "--raw"]) as any;
    expect(parsed.action).toBe("run");
    expect(parsed.db).toBe("NSM_QA_DB");
    expect(parsed.raw).toBe(true);
  });

  test("parses db listing subcommand", () => {
    const parsed = parse(["dbs", "--raw"]) as any;
    expect(parsed.action).toBe("dbs");
    expect(parsed.raw).toBe(true);
  });

  test("parses tui args", () => {
    const parsed = parse([
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
      parse(["unknown"]);
      throw new Error("expected parseArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("INVALID_SQL_SUBCOMMAND");
    }
  });

  test("throws when run query is missing", () => {
    try {
      parse(["run"]);
      throw new Error("expected parseArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("MISSING_SQL_QUERY");
    }
  });

  test("throws on invalid tui format", () => {
    try {
      parse(["tui", "--format", "xml"]);
      throw new Error("expected parseArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("SQL_TUI_INVALID_FORMAT");
    }
  });

  test("throws on invalid tui page size", () => {
    try {
      parse(["tui", "--page-size", "0"]);
      throw new Error("expected parseArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("SQL_TUI_INVALID_PAGE_SIZE");
    }
  });
});
