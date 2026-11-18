// E10: `wi-impl ad sql update --help` printed the help of every sql
// subcommand. The command's helpFor now narrows help.txt to the one asked.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runCommand } from "@belzabar/core/testing";
import sqlCommand from "../../commands/sql";
import { subcommandHelp } from "../../lib/args/subcommand-help";

const HELP = readFileSync(join(import.meta.dir, "../../commands/sql/help.txt"), "utf8");
const scoped = (sub: string) => subcommandHelp(HELP, [sub], "wi-impl ad sql");

describe("subcommandHelp on the sql help", () => {
  test("update: its entry, flags, checks and examples only", () => {
    const h = scoped("update");
    expect(h).toStartWith("Usage: wi-impl ad sql update");
    expect(h).toContain("Flags (update):");
    expect(h).toContain("SQL_WRONG_STATEMENT");
    expect(h).toContain("SQL_PARAMETER_MARKER");
    expect(h).toContain('wi-impl ad sql update "UPDATE');
    for (const other of ["Flags (run):", "Flags (insert):", "Flags (tui):", "TUI meta commands", "  dbs ", "  modify <", 'sql insert "INSERT']) {
      expect(h).not.toContain(other);
    }
    expect(h.length).toBeLessThan(HELP.length / 2);
  });

  test("tui keeps its meta commands; dbs has no SQL-statement sections", () => {
    expect(scoped("tui")).toContain("TUI meta commands (tui):");
    expect(scoped("dbs")).not.toContain("Bind parameters");
    expect(scoped("modify")).not.toContain("Bind parameters");
  });

  test("no subcommand, a flag first, or an unknown one: the whole help", () => {
    expect(subcommandHelp(HELP, [], "wi-impl ad sql")).toBe(HELP);
    expect(subcommandHelp(HELP, ["--llm"], "wi-impl ad sql")).toBe(HELP);
    expect(subcommandHelp(HELP, ["nope"], "wi-impl ad sql")).toBe(HELP);
  });
});

test("the runner applies helpFor: `sql update --help`", async () => {
  const r = await runCommand(sqlCommand, ["update", "--help"], { commandName: "sql", helpResolver: async () => HELP });
  const help = (r.envelope as any).data.help as string;
  expect(help).toContain("Flags (update):");
  expect(help).not.toContain("Flags (run):");
});
