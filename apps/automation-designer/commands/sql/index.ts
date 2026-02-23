import { CliError, ok, type CommandModule } from "@belzabar/core";
import { fetchSqlDatabases } from "../../lib/sql/api";
import {
  executeSqlReadQuery,
  loadSqlExecutionContext,
  resolveSqlDbContext,
  DEFAULT_SQL_DB_FALLBACK,
} from "../../lib/sql/executor";
import { normalizeSqlDatabases } from "../../lib/sql/selector";
import { runSqlTuiSession } from "../../lib/sql/tui/session";
import type { SqlTuiArgs } from "../../lib/sql/tui/types";
import type { NormalizedSqlDatabase } from "../../lib/sql/types";

interface SqlArgs {
  action: "run" | "dbs" | "tui";
  query?: string;
  db?: string;
  raw: boolean;
  tui?: SqlTuiArgs;
}

interface SqlDbsData {
  action: "dbs";
  databases: NormalizedSqlDatabase[];
  defaultResolution: {
    envValue?: string;
    fallbackNickname: string;
  };
  raw?: {
    databases: unknown;
  };
}

interface SqlRunData {
  action: "run";
  database: NormalizedSqlDatabase;
  selectedBy: "--db" | "env" | "fallback";
  query: string;
  success: true;
  statusCode?: number;
  rows: unknown[];
  rowCount: number;
  executionTime?: {
    time: number;
    unit: string;
  };
  raw?: {
    operation: unknown;
    payload: unknown;
    executionResult: unknown;
  };
}

interface SqlTuiData {
  action: "tui";
  startedAt: number;
  endedAt: number;
  queryCount: number;
  finalDatabase: {
    id: number;
    nickname: string;
  };
}

type SqlData = SqlDbsData | SqlRunData | SqlTuiData;

function getOptionValue(args: string[], name: string): string | undefined {
  const explicit = args.find((arg) => arg.startsWith(`${name}=`));
  if (explicit) {
    const value = explicit.split("=").slice(1).join("=").trim();
    return value || undefined;
  }

  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith("-")) return undefined;
  return next;
}

function parseDbArg(args: string[]): string | undefined {
  const value = getOptionValue(args, "--db");
  if (args.includes("--db") && !value) {
    throw new CliError("--db requires a database nickname or id.", {
      code: "SQL_DB_ARG_MISSING",
    });
  }

  if (args.some((arg) => arg.startsWith("--db=")) && !value) {
    throw new CliError("--db requires a database nickname or id.", {
      code: "SQL_DB_ARG_MISSING",
    });
  }

  return value;
}

function parseRunQueryArgs(args: string[]): string[] {
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    if (token === "--raw") continue;

    if (token.startsWith("--db=")) {
      continue;
    }

    if (token === "--db") {
      i += 1;
      continue;
    }

    positional.push(token);
  }

  return positional;
}

function parseTuiArgs(args: string[]): SqlTuiArgs {
  const db = parseDbArg(args);

  const formatValue = (getOptionValue(args, "--format") || "table").toLowerCase();
  if (formatValue !== "table" && formatValue !== "json") {
    throw new CliError("--format must be one of: table, json", {
      code: "SQL_TUI_INVALID_FORMAT",
    });
  }

  const pageSizeRaw = getOptionValue(args, "--page-size") || "50";
  const pageSize = Number.parseInt(pageSizeRaw, 10);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new CliError("--page-size must be a positive integer.", {
      code: "SQL_TUI_INVALID_PAGE_SIZE",
    });
  }

  return {
    db,
    format: formatValue,
    timing: args.includes("--timing"),
    history: !args.includes("--no-history"),
    pageSize,
  };
}

const command: CommandModule<SqlArgs, SqlData> = {
  schema: "ad.sql",
  parseArgs(args) {
    const action = args[0];
    if (!action) {
      throw new CliError("Missing SQL subcommand. Use one of: run, dbs, tui.", {
        code: "INVALID_SQL_SUBCOMMAND",
      });
    }

    if (action === "dbs") {
      return {
        action,
        raw: args.includes("--raw"),
      };
    }

    if (action === "run") {
      const rest = args.slice(1);
      const queryArgs = parseRunQueryArgs(rest);
      const query = queryArgs[0];

      if (!query) {
        throw new CliError("Missing SQL query argument. Usage: belz sql run \"select * from users limit 1\"", {
          code: "MISSING_SQL_QUERY",
        });
      }

      return {
        action,
        query,
        db: parseDbArg(rest),
        raw: rest.includes("--raw"),
      };
    }

    if (action === "tui") {
      const rest = args.slice(1);
      return {
        action,
        raw: false,
        db: parseDbArg(rest),
        tui: parseTuiArgs(rest),
      };
    }

    throw new CliError(`Unknown SQL subcommand '${action}'. Use one of: run, dbs, tui.`, {
      code: "INVALID_SQL_SUBCOMMAND",
    });
  },
  async execute(args, context) {
    const envDefault = process.env.BELZ_SQL_DEFAULT_DB?.trim() || undefined;

    if (args.action === "dbs") {
      const rawDatabases = await fetchSqlDatabases();
      const databases = normalizeSqlDatabases(rawDatabases);

      const data: SqlDbsData = {
        action: "dbs",
        databases,
        defaultResolution: {
          envValue: envDefault,
          fallbackNickname: DEFAULT_SQL_DB_FALLBACK,
        },
      };

      if (args.raw) {
        data.raw = {
          databases: rawDatabases,
        };
      }

      return ok(data);
    }

    if (args.action === "run") {
      const [dbContext, executionContext] = await Promise.all([
        resolveSqlDbContext({
          requestedDb: args.db,
          envDefault,
          fallbackNickname: DEFAULT_SQL_DB_FALLBACK,
        }),
        loadSqlExecutionContext(),
      ]);

      const result = await executeSqlReadQuery({
        query: args.query as string,
        database: dbContext.resolution.selected,
        context: executionContext,
        raw: args.raw,
      });

      const data: SqlRunData = {
        action: "run",
        database: result.database,
        selectedBy: dbContext.resolution.selectedBy,
        query: result.query,
        success: true,
        statusCode: result.statusCode,
        rows: result.rows,
        rowCount: result.rowCount,
        executionTime: result.executionTime,
        raw: result.raw,
      };

      return ok(data);
    }

    if (context.outputMode === "llm") {
      throw new CliError("sql tui is interactive and not supported with --llm.", {
        code: "SQL_TUI_UNSUPPORTED_IN_LLM",
      });
    }

    const tuiArgs = args.tui;
    if (!tuiArgs) {
      throw new CliError("Failed to parse TUI arguments.", {
        code: "SQL_TUI_ARGS_MISSING",
      });
    }

    const sessionSummary = await runSqlTuiSession(tuiArgs);
    return ok(sessionSummary);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;

    const data = envelope.data as SqlData;

    if (data.action === "dbs") {
      ui.success(`Found ${data.databases.length} SQL database configurations.`);
      ui.table(
        ["ID", "Nickname", "Source", "Host", "Port", "Usage", "Auth Type"],
        data.databases.map((db) => [
          db.id,
          db.nickname,
          db.source || "",
          db.host || "",
          db.port || "",
          db.authUsageType || "",
          db.derivedAuthType || "",
        ])
      );
      return;
    }

    if (data.action === "run") {
      ui.success(`SQL query executed successfully against '${data.database.nickname}'.`);
      ui.table(
        ["Property", "Value"],
        [
          ["Database", `${data.database.nickname} (${data.database.id})`],
          ["Selected By", data.selectedBy],
          ["Status Code", data.statusCode ?? ""],
          ["Rows", data.rowCount],
          ["Execution Time", data.executionTime ? `${data.executionTime.time} ${data.executionTime.unit}` : ""],
          ["Query", data.query],
        ]
      );

      ui.section("Rows");
      if (data.rows.length === 0) {
        ui.text("(No rows returned)");
      } else {
        ui.object(data.rows);
      }

      if (data.raw) {
        ui.section("Raw Data");
        ui.object(data.raw);
      }
      return;
    }

    ui.success("SQL TUI session ended.");
    ui.table(
      ["Property", "Value"],
      [
        ["Queries Executed", data.queryCount],
        ["Final Database", `${data.finalDatabase.nickname} (${data.finalDatabase.id})`],
        ["Duration", `${Math.max(0, data.endedAt - data.startedAt)} ms`],
      ]
    );
  },
};

export default command;
