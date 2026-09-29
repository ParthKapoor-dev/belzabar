import { CliError, defineSubcommands, ok, type CommandModule } from "@belzabar/core";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { fetchSqlDatabases } from "../../lib/sql/api";
import {
  executeSqlReadQuery,
  executeSqlUpdate,
  executeSqlInsert,
  executeSqlModify,
  loadSqlExecutionContext,
  loadSqlUpdateContext,
  loadSqlInsertContext,
  loadSqlModifyContext,
  resolveSqlDbContext,
  sqlDefaultDb,
} from "../../lib/sql/executor";
import { normalizeSqlDatabases } from "../../lib/sql/selector";
import { assertReadOnlySql, buildExplainSql, checkReadOnlySql } from "../../lib/sql/read-only";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { runSqlTuiSession } from "../../lib/sql/tui/session";
import type { SqlTuiArgs } from "../../lib/sql/tui/types";
import type { NormalizedSqlDatabase, SqlDbSelectedBy } from "../../lib/sql/types";

interface SqlArgs {
  action: "run" | "dbs" | "tui" | "update" | "insert" | "modify" | "explain";
  query?: string;
  explain?: { statement: string; analyze: boolean; buffers: boolean; format: "text" | "json" };
  db?: string;
  raw: boolean;
  yes?: boolean;
  tui?: SqlTuiArgs;
}

interface SqlDbsData {
  action: "dbs";
  databases: NormalizedSqlDatabase[];
  defaultResolution: {
    /** `environments.<env>.sqlDefaultDb` from ~/.belz/config.json. */
    configValue?: string;
    /** BELZ_SQL_DEFAULT_DB. */
    envValue?: string;
  };
  raw?: {
    databases: unknown;
  };
}

interface SqlRunData {
  action: "run";
  database: NormalizedSqlDatabase;
  selectedBy: SqlDbSelectedBy;
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

interface SqlExplainData {
  action: "explain";
  database: NormalizedSqlDatabase;
  selectedBy: SqlDbSelectedBy;
  /** The statement as given. */
  statement: string;
  /** What was sent: EXPLAIN [(options)] <statement>. */
  query: string;
  analyze: boolean;
  format: "text" | "json";
  /** text: the plan lines; json: the parsed plan. */
  plan: string[] | unknown;
  /** From the plan (ANALYZE): planning / execution time in ms. */
  timing?: { planningMs?: number; executionMs?: number };
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

interface SqlUpdateData {
  action: "update";
  database: NormalizedSqlDatabase;
  selectedBy: SqlDbSelectedBy;
  query: string;
  success: true;
  statusCode?: number;
  rowsAffected: number;
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

interface SqlInsertData {
  action: "insert";
  database: NormalizedSqlDatabase;
  selectedBy: SqlDbSelectedBy;
  query: string;
  success: true;
  statusCode?: number;
  rowsAffected: number;
  /** Generated key values — needs `RETURNING <key column>` in the query (F25). */
  generatedValues: string[];
  /** Multi-row RETURNING: every returned key row. */
  generatedKeys?: Array<Record<string, string>>;
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

interface SqlModifyData {
  action: "modify";
  database: NormalizedSqlDatabase;
  selectedBy: SqlDbSelectedBy;
  query: string;
  success: true;
  statusCode?: number;
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

type SqlData = SqlDbsData | SqlRunData | SqlExplainData | SqlUpdateData | SqlInsertData | SqlModifyData | SqlTuiData;

/** AD-32: SQL writes follow the AD write contract (confirm, or --yes; --yes mandatory in --llm). */
async function confirmSqlWrite(
  args: SqlArgs,
  action: "update" | "insert" | "modify",
  database: NormalizedSqlDatabase,
  outputMode: "human" | "llm",
): Promise<void> {
  await requireConfirmation({
    yes: !!args.yes,
    outputMode,
    action: `run SQL ${action} against '${database.nickname}'`,
    details: [
      ["Database", `${database.nickname} (${database.id})`],
      ["Query", args.query ?? ""],
    ],
  });
  logIntent("POST", "/rest/api/automation/chain/test", { sql: action, db: database.nickname });
}

const DB_FLAG = { db: { type: "string" } } as const;
const RAW_FLAG = { raw: { type: "boolean" } } as const;
const SQL_CODES = { UNKNOWN_SUBCOMMAND: "INVALID_SQL_SUBCOMMAND", MISSING_SUBCOMMAND: "INVALID_SQL_SUBCOMMAND" } as const;

function queryPositional(action: string, example: string) {
  return [
    {
      name: "query",
      required: true,
      missingCode: "MISSING_SQL_QUERY",
      missingMessage: `Missing SQL query argument. Usage: belz ad sql ${action} "${example}"`,
    },
  ] as const;
}

export const args = defineSubcommands(
  {
    dbs: { flags: { ...AD_COMMON_FLAGS, ...RAW_FLAG } },
    run: {
      positionals: queryPositional("run", "select * from users limit 1"),
      flags: { ...AD_COMMON_FLAGS, ...DB_FLAG, ...RAW_FLAG },
    },
    explain: {
      positionals: queryPositional("explain", "select * from users where id = 1"),
      flags: {
        ...AD_COMMON_FLAGS,
        ...DB_FLAG,
        ...RAW_FLAG,
        analyze: { type: "boolean" },
        buffers: { type: "boolean" },
        format: { type: "enum", values: ["text", "json"], default: "text" },
      },
    },
    update: {
      positionals: queryPositional("update", "UPDATE table SET col = val WHERE ..."),
      flags: { ...AD_COMMON_FLAGS, ...DB_FLAG, ...RAW_FLAG, ...AD_YES_FLAG },
    },
    insert: {
      positionals: queryPositional("insert", "INSERT INTO table (col) VALUES ('val')"),
      flags: { ...AD_COMMON_FLAGS, ...DB_FLAG, ...RAW_FLAG, ...AD_YES_FLAG },
    },
    modify: {
      positionals: queryPositional("modify", "ALTER TABLE users ADD COLUMN age INT"),
      flags: { ...AD_COMMON_FLAGS, ...DB_FLAG, ...RAW_FLAG, ...AD_YES_FLAG },
    },
    tui: {
      flags: {
        ...AD_COMMON_FLAGS,
        ...DB_FLAG,
        mode: { type: "string" },
        format: { type: "string", default: "table" },
        timing: { type: "boolean" },
        "page-size": { type: "string", default: "50" },
        "no-history": { type: "boolean" },
      },
    },
  },
  {
    command: "belz ad sql",
    codes: SQL_CODES,
    missingMessage: "Missing SQL subcommand. Use one of: run, explain, dbs, tui, update, insert, modify.",
  },
);

function parseTuiOptions(flags: {
  db?: string;
  mode?: string;
  format: string;
  timing: boolean;
  pageSize: string;
  noHistory: boolean;
}): SqlTuiArgs {
  const formatValue = flags.format.toLowerCase();
  if (formatValue !== "table" && formatValue !== "json") {
    throw new CliError("--format must be one of: table, json", {
      code: "SQL_TUI_INVALID_FORMAT",
    });
  }

  const pageSize = Number(flags.pageSize);
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new CliError("--page-size must be a positive integer.", {
      code: "SQL_TUI_INVALID_PAGE_SIZE",
    });
  }

  const modeRaw = flags.mode;
  if (modeRaw !== undefined && modeRaw !== "read" && modeRaw !== "insert" && modeRaw !== "update" && modeRaw !== "modify") {
    throw new CliError("--mode must be one of: read, insert, update, modify", {
      code: "SQL_TUI_INVALID_MODE",
    });
  }

  return {
    db: flags.db,
    mode: modeRaw,
    format: formatValue,
    timing: flags.timing,
    history: !flags.noHistory,
    pageSize,
  };
}

/** The plan from EXPLAIN's `QUERY PLAN` rows, plus ANALYZE timings when present. */
export function readPlan(rows: unknown[], format: "text" | "json"): { plan: string[] | unknown; timing?: { planningMs?: number; executionMs?: number } } {
  const cells = rows.map((r) => (r && typeof r === "object" ? Object.values(r as Record<string, unknown>)[0] : r));
  if (format === "json") {
    let plan: unknown = cells[0];
    if (typeof plan === "string") {
      try {
        plan = JSON.parse(plan);
      } catch {
        /* keep the text */
      }
    }
    const top = Array.isArray(plan) ? (plan[0] as Record<string, unknown> | undefined) : undefined;
    const timing: { planningMs?: number; executionMs?: number } = {};
    if (typeof top?.["Planning Time"] === "number") timing.planningMs = top["Planning Time"] as number;
    if (typeof top?.["Execution Time"] === "number") timing.executionMs = top["Execution Time"] as number;
    return Object.keys(timing).length > 0 ? { plan, timing } : { plan };
  }
  const lines = cells.map((c) => String(c ?? ""));
  const timing: { planningMs?: number; executionMs?: number } = {};
  for (const l of lines) {
    const m = /^\s*(Planning|Execution) Time:\s*([\d.]+)\s*ms/.exec(l);
    if (m) timing[m[1] === "Planning" ? "planningMs" : "executionMs"] = Number(m[2]);
  }
  return Object.keys(timing).length > 0 ? { plan: lines, timing } : { plan: lines };
}

const command: CommandModule<SqlArgs, SqlData> = {
  schema: "ad.sql",
  // `tui` can start in, or switch to, update/insert/modify mode: always a write (explicit --env).
  writes: (a) => a.action === "update" || a.action === "insert" || a.action === "modify" || a.action === "tui",
  parseArgs(argv) {
    const parsed = args.parse(argv);
    resolveAdCommon(parsed.flags, "list", "sql");

    switch (parsed.subcommand) {
      case "dbs":
        return { action: "dbs", raw: parsed.flags.raw };
      case "run":
        // F2: refuse anything but a single read statement before any network call.
        assertReadOnlySql(parsed.positionals.query);
        return { action: "run", query: parsed.positionals.query, db: parsed.flags.db, raw: parsed.flags.raw };
      case "explain": {
        // 7.11: the explained statement must pass the read-only gate — ANALYZE really executes it.
        const statement = parsed.positionals.query;
        if (/^explain\b/i.test(checkReadOnlySql(statement).normalized)) {
          throw new CliError("Pass the statement without EXPLAIN; use --analyze / --buffers / --format for the options.", {
            code: "SQL_EXPLAIN_NESTED",
          });
        }
        assertReadOnlySql(statement, "sql explain");
        const f = parsed.flags;
        if (f.buffers && !f.analyze) {
          throw new CliError("--buffers needs --analyze (buffer counts come from executing the statement).", { code: "SQL_EXPLAIN_BUFFERS_NEEDS_ANALYZE" });
        }
        const explain = { statement, analyze: f.analyze, buffers: f.buffers, format: f.format as "text" | "json" };
        const query = buildExplainSql(statement, explain);
        assertReadOnlySql(query, "sql explain");
        return { action: "explain", query, explain, db: f.db, raw: f.raw };
      }
      case "update":
      case "insert":
      case "modify":
        return {
          action: parsed.subcommand,
          query: parsed.positionals.query,
          db: parsed.flags.db,
          raw: parsed.flags.raw,
          yes: parsed.flags.yes,
        };
      case "tui":
        return { action: "tui", raw: false, db: parsed.flags.db, tui: parseTuiOptions(parsed.flags) };
    }
  },
  async execute(args, context) {
    const envDefault = sqlDefaultDb(context.env.name);

    if (args.action === "dbs") {
      const rawDatabases = await fetchSqlDatabases();
      const databases = normalizeSqlDatabases(rawDatabases);

      const data: SqlDbsData = {
        action: "dbs",
        databases,
        defaultResolution: {
          ...(envDefault?.source === "config" ? { configValue: envDefault.value } : {}),
          ...(envDefault?.source === "env" ? { envValue: envDefault.value } : {}),
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

    if (args.action === "explain") {
      const [dbContext, executionContext] = await Promise.all([
        resolveSqlDbContext({ requestedDb: args.db, envDefault }),
        loadSqlExecutionContext(),
      ]);
      const ex = args.explain!;
      const result = await executeSqlReadQuery({
        query: args.query as string,
        database: dbContext.resolution.selected,
        context: executionContext,
        raw: args.raw,
      });
      const { plan, timing } = readPlan(result.rows, ex.format);
      const data: SqlExplainData = {
        action: "explain",
        database: result.database,
        selectedBy: dbContext.resolution.selectedBy,
        statement: ex.statement,
        query: result.query,
        analyze: ex.analyze,
        format: ex.format,
        plan,
        ...(timing ? { timing } : {}),
        executionTime: result.executionTime,
        raw: result.raw,
      };
      return ok(data);
    }

    if (args.action === "update") {
      const [dbContext, updateContext] = await Promise.all([
        resolveSqlDbContext({
          requestedDb: args.db,
          envDefault,
        }),
        loadSqlUpdateContext(),
      ]);

      await confirmSqlWrite(args, "update", dbContext.resolution.selected, context.outputMode);

      const result = await executeSqlUpdate({
        query: args.query as string,
        database: dbContext.resolution.selected,
        context: updateContext,
        raw: args.raw,
      });

      const data: SqlUpdateData = {
        action: "update",
        database: result.database,
        selectedBy: dbContext.resolution.selectedBy,
        query: result.query,
        success: true,
        statusCode: result.statusCode,
        rowsAffected: result.rowsAffected,
        executionTime: result.executionTime,
        raw: result.raw,
      };

      return ok(data);
    }

    if (args.action === "insert") {
      const [dbContext, insertContext] = await Promise.all([
        resolveSqlDbContext({
          requestedDb: args.db,
          envDefault,
        }),
        loadSqlInsertContext(),
      ]);

      await confirmSqlWrite(args, "insert", dbContext.resolution.selected, context.outputMode);

      const result = await executeSqlInsert({
        query: args.query as string,
        database: dbContext.resolution.selected,
        context: insertContext,
        raw: args.raw,
      });

      const data: SqlInsertData = {
        action: "insert",
        database: result.database,
        selectedBy: dbContext.resolution.selectedBy,
        query: result.query,
        success: true,
        statusCode: result.statusCode,
        rowsAffected: result.rowsAffected,
        generatedValues: result.generatedValues,
        ...(result.generatedKeys ? { generatedKeys: result.generatedKeys } : {}),
        executionTime: result.executionTime,
        raw: result.raw,
      };

      return ok(data);
    }

    if (args.action === "modify") {
      const [dbContext, modifyContext] = await Promise.all([
        resolveSqlDbContext({
          requestedDb: args.db,
          envDefault,
        }),
        loadSqlModifyContext(),
      ]);

      await confirmSqlWrite(args, "modify", dbContext.resolution.selected, context.outputMode);

      const result = await executeSqlModify({
        query: args.query as string,
        database: dbContext.resolution.selected,
        context: modifyContext,
        raw: args.raw,
      });

      const data: SqlModifyData = {
        action: "modify",
        database: result.database,
        selectedBy: dbContext.resolution.selectedBy,
        query: result.query,
        success: true,
        statusCode: result.statusCode,
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

    if (data.action === "explain") {
      ui.success(`EXPLAIN${data.analyze ? " ANALYZE" : ""} on '${data.database.nickname}'.`);
      if (Array.isArray(data.plan) && data.plan.every((l) => typeof l === "string")) ui.text((data.plan as string[]).join("\n"));
      else ui.object(data.plan);
      if (data.raw) {
        ui.section("Raw Data");
        ui.object(data.raw);
      }
      return;
    }

    if (data.action === "update") {
      ui.success(`SQL update executed successfully against '${data.database.nickname}'.`);
      ui.table(
        ["Property", "Value"],
        [
          ["Database", `${data.database.nickname} (${data.database.id})`],
          ["Selected By", data.selectedBy],
          ["Status Code", data.statusCode ?? ""],
          ["Rows Affected", data.rowsAffected],
          ["Execution Time", data.executionTime ? `${data.executionTime.time} ${data.executionTime.unit}` : ""],
          ["Query", data.query],
        ]
      );

      if (data.raw) {
        ui.section("Raw Data");
        ui.object(data.raw);
      }
      return;
    }

    if (data.action === "insert") {
      ui.success(`SQL insert executed successfully against '${data.database.nickname}'.`);
      ui.table(
        ["Property", "Value"],
        [
          ["Database", `${data.database.nickname} (${data.database.id})`],
          ["Selected By", data.selectedBy],
          ["Status Code", data.statusCode ?? ""],
          ["Rows Affected", data.rowsAffected],
          ["Execution Time", data.executionTime ? `${data.executionTime.time} ${data.executionTime.unit}` : ""],
          ["Query", data.query],
        ]
      );

      if (data.generatedValues.length > 0) {
        ui.section("Generated Values");
        for (const val of data.generatedValues) {
          ui.text(val);
        }
      }

      if (data.raw) {
        ui.section("Raw Data");
        ui.object(data.raw);
      }
      return;
    }

    if (data.action === "modify") {
      ui.success(`Schema modification executed successfully against '${data.database.nickname}'.`);
      ui.table(
        ["Property", "Value"],
        [
          ["Database", `${data.database.nickname} (${data.database.id})`],
          ["Selected By", data.selectedBy],
          ["Status Code", data.statusCode ?? ""],
          ["Execution Time", data.executionTime ? `${data.executionTime.time} ${data.executionTime.unit}` : ""],
          ["Query", data.query],
        ]
      );

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
