import type { SqlTuiMetaCommand } from "./types";

const HELP_TEXT = [
  "SQL TUI commands:",
  "  \\q                 Quit session",
  "  \\h                 Show help",
  "  \\status            Show active DB/session settings",
  "  \\db                List available databases",
  "  \\use <db>          Switch database by nickname or id",
  "  \\history           Show recent query history",
  "  \\clear             Clear terminal",
  "  \\timing            Toggle timing output",
  "  \\format [table|json] Set output format",
  "  \\last              Show last executed query",
  "  \\r                 Reset current multiline buffer",
  "",
  "SQL execution:",
  "  End statements with ';' to execute.",
  "  Multiline SQL is supported.",
].join("\n");

export const SQL_TUI_META_COMMANDS = [
  "\\q",
  "\\h",
  "\\status",
  "\\db",
  "\\use",
  "\\history",
  "\\clear",
  "\\timing",
  "\\format",
  "\\last",
  "\\r",
] as const;

export function getSqlTuiHelpText(): string {
  return HELP_TEXT;
}

export function parseSqlTuiMetaCommand(input: string): SqlTuiMetaCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("\\")) {
    return null;
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const command = tokens[0] || "";
  const args = tokens.slice(1);

  switch (command) {
    case "\\q":
      return { type: "quit", args, raw: trimmed };
    case "\\h":
      return { type: "help", args, raw: trimmed };
    case "\\status":
      return { type: "status", args, raw: trimmed };
    case "\\db":
      return { type: "db", args, raw: trimmed };
    case "\\use":
      return { type: "use", args, raw: trimmed };
    case "\\history":
      return { type: "history", args, raw: trimmed };
    case "\\clear":
      return { type: "clear", args, raw: trimmed };
    case "\\timing":
      return { type: "timing", args, raw: trimmed };
    case "\\format":
      return { type: "format", args, raw: trimmed };
    case "\\last":
      return { type: "last", args, raw: trimmed };
    case "\\r":
      return { type: "reset", args, raw: trimmed };
    default:
      return { type: "unknown", args, raw: trimmed };
  }
}
