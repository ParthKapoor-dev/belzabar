import { CliError } from "@belzabar/core";
import readline from "node:readline";
import { executeSqlReadQuery, resolveSqlDbContext, loadSqlExecutionContext, DEFAULT_SQL_DB_FALLBACK } from "../executor";
import { getSqlTuiHelpText, parseSqlTuiMetaCommand, SQL_TUI_META_COMMANDS } from "./commands";
import { loadSqlHistory, persistSqlHistory } from "./history";
import { renderRowsWithPagination } from "./renderer";
import type { SqlTuiArgs, SqlTuiSessionState, SqlTuiFormat } from "./types";

interface SqlTuiSessionSummary {
  action: "tui";
  startedAt: number;
  endedAt: number;
  queryCount: number;
  finalDatabase: {
    id: number;
    nickname: string;
  };
}

function isCompleteStatement(buffer: string[]): boolean {
  const sql = buffer.join("\n").trim();
  return sql.endsWith(";");
}

function normalizeQueryForHistory(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function buildPrompt(state: SqlTuiSessionState): string {
  if (state.buffer.length > 0) {
    return "...> ";
  }

  return `sql(${state.activeDatabase.nickname})> `;
}

function completer(line: string, dbNames: string[]): [string[], string] {
  const trimmed = line.trimStart();

  if (!trimmed.startsWith("\\")) {
    return [[], line];
  }

  if (trimmed.startsWith("\\use")) {
    const useArg = trimmed.replace(/^\\use\s*/, "");
    const hits = dbNames.filter((name) => name.toLowerCase().startsWith(useArg.toLowerCase()));
    return [hits.length ? hits : dbNames, useArg];
  }

  const hits = SQL_TUI_META_COMMANDS.filter((cmd) => cmd.startsWith(trimmed));
  return [hits.length ? [...hits] : [...SQL_TUI_META_COMMANDS], trimmed];
}

async function switchDatabase(state: SqlTuiSessionState, requestedDb: string): Promise<void> {
  const context = await resolveSqlDbContext({
    requestedDb,
    envDefault: state.envDefault,
    fallbackNickname: DEFAULT_SQL_DB_FALLBACK,
  });

  state.databases = context.databases;
  state.activeDatabase = context.resolution.selected;
}

async function renderDatabases(state: SqlTuiSessionState): Promise<void> {
  const context = await resolveSqlDbContext({
    requestedDb: String(state.activeDatabase.id),
    envDefault: state.envDefault,
    fallbackNickname: DEFAULT_SQL_DB_FALLBACK,
  });

  state.databases = context.databases;
  state.activeDatabase = context.resolution.selected;

  console.log("\nAvailable databases:");
  for (const db of state.databases) {
    const marker = db.id === state.activeDatabase.id ? "*" : " ";
    console.log(`${marker} ${db.nickname} (${db.id})  ${db.host || ""}`.trimEnd());
  }
}

function renderStatus(state: SqlTuiSessionState): void {
  console.log("\nSession status:");
  console.log(`  Database : ${state.activeDatabase.nickname} (${state.activeDatabase.id})`);
  console.log(`  Format   : ${state.format}`);
  console.log(`  Timing   : ${state.timing ? "on" : "off"}`);
  console.log(`  PageSize : ${state.pageSize}`);
  console.log(`  History  : ${state.historyEnabled ? "on" : "off"}`);
  console.log(`  Buffer   : ${state.buffer.length > 0 ? `${state.buffer.length} line(s)` : "empty"}`);
}

async function handleMetaCommand(options: {
  input: string;
  state: SqlTuiSessionState;
  ask: (prompt: string) => Promise<string>;
  onQuit: () => void;
}): Promise<boolean> {
  const meta = parseSqlTuiMetaCommand(options.input);
  if (!meta) {
    return false;
  }

  switch (meta.type) {
    case "quit":
      options.onQuit();
      return true;
    case "help":
      console.log(getSqlTuiHelpText());
      return true;
    case "status":
      renderStatus(options.state);
      return true;
    case "db":
      await renderDatabases(options.state);
      return true;
    case "use": {
      const requested = meta.args.join(" ").trim();
      if (!requested) {
        console.log("Usage: \\use <db-name-or-id>");
        return true;
      }

      try {
        await switchDatabase(options.state, requested);
        console.log(`Switched to ${options.state.activeDatabase.nickname} (${options.state.activeDatabase.id}).`);
      } catch (error: any) {
        console.log(error.message || String(error));
      }

      return true;
    }
    case "history": {
      if (options.state.historyEntries.length === 0) {
        console.log("(No history)");
        return true;
      }

      const start = Math.max(0, options.state.historyEntries.length - 25);
      const recent = options.state.historyEntries.slice(start);
      recent.forEach((entry, idx) => {
        console.log(`${start + idx + 1}: ${entry}`);
      });
      return true;
    }
    case "clear":
      process.stdout.write("\x1Bc");
      return true;
    case "timing":
      options.state.timing = !options.state.timing;
      console.log(`Timing is now ${options.state.timing ? "on" : "off"}.`);
      return true;
    case "format": {
      const format = (meta.args[0] || "").toLowerCase();
      if (!format) {
        console.log(`Current format: ${options.state.format}`);
        return true;
      }

      if (format !== "table" && format !== "json") {
        console.log("Usage: \\format [table|json]");
        return true;
      }

      options.state.format = format as SqlTuiFormat;
      console.log(`Format set to ${options.state.format}.`);
      return true;
    }
    case "last":
      if (!options.state.lastQuery) {
        console.log("(No previous query)");
      } else {
        console.log(options.state.lastQuery);
      }
      return true;
    case "reset":
      options.state.buffer = [];
      console.log("Input buffer cleared.");
      return true;
    case "unknown":
    default:
      console.log(`Unknown command: ${meta.raw}. Use \\h for help.`);
      return true;
  }
}

export async function runSqlTuiSession(args: SqlTuiArgs): Promise<SqlTuiSessionSummary> {
  const startedAt = Date.now();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("sql tui requires an interactive terminal (TTY).", {
      code: "SQL_TUI_REQUIRES_TTY",
    });
  }

  const envDefault = process.env.BELZ_SQL_DEFAULT_DB?.trim() || undefined;

  const [dbContext, executionContext, historyEntries] = await Promise.all([
    resolveSqlDbContext({
      requestedDb: args.db,
      envDefault,
      fallbackNickname: DEFAULT_SQL_DB_FALLBACK,
    }),
    loadSqlExecutionContext(),
    args.history ? loadSqlHistory() : Promise.resolve([]),
  ]);

  const state: SqlTuiSessionState = {
    activeDatabase: dbContext.resolution.selected,
    databases: dbContext.databases,
    executionContext,
    format: args.format,
    timing: args.timing,
    pageSize: args.pageSize,
    envDefault,
    buffer: [],
    lastQuery: null,
    historyEnabled: args.history,
    historyEntries: [...historyEntries],
    historyToPersist: [],
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 2000,
    terminal: process.stdin.isTTY,
    completer: (line: string) => completer(line, state.databases.map((db) => db.nickname)),
  });

  if (state.historyEnabled && state.historyEntries.length > 0) {
    rl.history = [...state.historyEntries].reverse();
  }

  const ask = async (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  };

  let exitRequested = false;
  let closed = false;
  let queryCount = 0;

  rl.on("close", () => {
    closed = true;
    exitRequested = true;
  });

  rl.on("SIGINT", () => {
    if (state.buffer.length > 0) {
      state.buffer = [];
      console.log("\nInput buffer cleared.");
      return;
    }

    console.log("\nUse \\q to quit.");
  });

  console.log("Belz SQL TUI");
  console.log(`Connected to ${state.activeDatabase.nickname} (${state.activeDatabase.id})`);
  console.log("Type \\h for help. End SQL with ';' to execute.");

  while (!exitRequested && !closed) {
    const prompt = buildPrompt(state);
    const input = await ask(prompt);

    if (exitRequested || closed) {
      break;
    }

    const metaHandled = await handleMetaCommand({
      input,
      state,
      ask,
      onQuit: () => {
        exitRequested = true;
      },
    });

    if (metaHandled) {
      continue;
    }

    if (!input.trim() && state.buffer.length === 0) {
      continue;
    }

    state.buffer.push(input);
    if (!isCompleteStatement(state.buffer)) {
      continue;
    }

    const rawQuery = state.buffer.join("\n").trim();
    const query = rawQuery.replace(/;+\s*$/, "").trim();
    state.buffer = [];

    if (!query) {
      continue;
    }

    const started = Date.now();
    try {
      const result = await executeSqlReadQuery({
        query,
        database: state.activeDatabase,
        context: state.executionContext,
      });

      queryCount += 1;
      state.lastQuery = query;

      const normalizedForHistory = normalizeQueryForHistory(query);
      if (state.historyEnabled && normalizedForHistory) {
        state.historyEntries.push(normalizedForHistory);
        state.historyToPersist.push(normalizedForHistory);
      }

      await renderRowsWithPagination({
        rows: result.rows,
        format: state.format,
        pageSize: state.pageSize,
        ask,
      });

      if (state.timing) {
        const backendTime = result.executionTime
          ? `${result.executionTime.time} ${result.executionTime.unit}`
          : `${Date.now() - started} ms`;
        console.log(`Time: ${backendTime} | Rows: ${result.rowCount}`);
      }
    } catch (error: any) {
      if (error instanceof CliError) {
        console.log(`Error [${error.code}]: ${error.message}`);
        if (error.details) {
          console.dir(error.details, { depth: null, colors: true });
        }
      } else {
        console.log(`Error: ${error?.message || String(error)}`);
      }
    }
  }

  rl.close();

  if (state.historyEnabled) {
    await persistSqlHistory(historyEntries, state.historyToPersist);
  }

  return {
    action: "tui",
    startedAt,
    endedAt: Date.now(),
    queryCount,
    finalDatabase: {
      id: state.activeDatabase.id,
      nickname: state.activeDatabase.nickname,
    },
  };
}
