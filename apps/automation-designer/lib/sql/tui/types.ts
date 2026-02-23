import type { NormalizedSqlDatabase } from "../types";
import type { SqlExecutionContext } from "../executor";

export type SqlTuiFormat = "table" | "json";

export interface SqlTuiArgs {
  db?: string;
  format: SqlTuiFormat;
  timing: boolean;
  history: boolean;
  pageSize: number;
}

export interface SqlTuiSessionState {
  activeDatabase: NormalizedSqlDatabase;
  databases: NormalizedSqlDatabase[];
  executionContext: SqlExecutionContext;
  format: SqlTuiFormat;
  timing: boolean;
  pageSize: number;
  envDefault?: string;
  buffer: string[];
  lastQuery: string | null;
  historyEnabled: boolean;
  historyEntries: string[];
  historyToPersist: string[];
}

export type SqlTuiMetaCommandType =
  | "quit"
  | "help"
  | "status"
  | "db"
  | "use"
  | "history"
  | "clear"
  | "timing"
  | "format"
  | "last"
  | "reset"
  | "unknown";

export interface SqlTuiMetaCommand {
  type: SqlTuiMetaCommandType;
  args: string[];
  raw: string;
}
