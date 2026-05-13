import { describe, expect, test } from "bun:test";
import { parseSqlTuiMetaCommand } from "../../lib/sql/tui/commands";

describe("sql tui meta command parser", () => {
  test("returns null for normal sql", () => {
    const parsed = parseSqlTuiMetaCommand("select 1;");
    expect(parsed).toBeNull();
  });

  test("parses \\use", () => {
    const parsed = parseSqlTuiMetaCommand("\\use NSM_QA_DB");
    expect(parsed?.type).toBe("use");
    expect(parsed?.args[0]).toBe("NSM_QA_DB");
  });

  test("parses \\format", () => {
    const parsed = parseSqlTuiMetaCommand("\\format json");
    expect(parsed?.type).toBe("format");
    expect(parsed?.args[0]).toBe("json");
  });

  test("marks unknown slash command", () => {
    const parsed = parseSqlTuiMetaCommand("\\foo");
    expect(parsed?.type).toBe("unknown");
  });
});
