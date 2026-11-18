import { CliError, defineSubcommands, failWithData, ok, type CommandModule, type CommandResult } from "@belzabar/core";
import { AD_YES_FLAG } from "../../lib/args/common";
import { subcommandHelp } from "../../lib/args/subcommand-help";
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
import { assertNoParameterMarkers, assertReadOnlySql, assertWriteSql, buildExplainSql, checkReadOnlySql, splitSqlStatements } from "../../lib/sql/read-only";
import { readSqlSource } from "../../lib/sql/source";
import {
  buildDescribeQuery,
  buildSimilarTablesQuery,
  buildTablesQuery,
  parseTableName,
  readColumns,
  readTables,
  type SqlColumn,
  type SqlTableRef,
} from "../../lib/sql/schema";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { runSqlTuiSession } from "../../lib/sql/tui/session";
import type { SqlTuiArgs } from "../../lib/sql/tui/types";
import type { NormalizedSqlDatabase, SqlDbSelectedBy } from "../../lib/sql/types";

interface SqlArgs {
  action: "run" | "dbs" | "tui" | "update" | "insert" | "modify" | "explain" | "tables" | "describe";
  query?: string;
  /** Several `;`-separated statements (from --file, stdin or the argument): run in order, one result each. */
  statements?: string[];
  explain?: { statement: string; analyze: boolean; buffers: boolean; format: "text" | "json" };
  db?: string;
  raw: boolean;
  yes?: boolean;
  tui?: SqlTuiArgs;
  /** `tables`: --schema / --like; `describe`: the table (and its schema, from `schema.table`). */
  schema?: { schema?: string; like?: string; table?: string };
}

interface SqlDbsData {
  action: "dbs";
  databases: NormalizedSqlDatabase[];
  defaultResolution: {
    /** `environments.<env>.sqlDefaultDb` from ~/.wi-impl/config.json. */
    configValue?: string;
    /** WI_IMPL_SQL_DEFAULT_DB. */
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
  /** Generated key values — needs `RETURNING <key column>` in the query. */
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

/** One statement of a batch: its result fields (rows / rowsAffected / …), or its error. */
interface SqlBatchResult {
  /** 1-based position in the input. */
  index: number;
  query: string;
  ok: boolean;
  rows?: unknown[];
  rowCount?: number;
  rowsAffected?: number;
  generatedValues?: string[];
  executionTime?: { time: number; unit: string };
  error?: { code: string; message: string; details?: unknown };
  /** A write batch stops at its first failure: the statements after it are not sent. */
  notRun?: true;
}

interface SqlBatchData {
  action: "run" | "update" | "insert" | "modify";
  batch: true;
  database: NormalizedSqlDatabase;
  selectedBy: SqlDbSelectedBy;
  statementCount: number;
  okCount: number;
  failedCount: number;
  results: SqlBatchResult[];
}

interface SqlTablesData {
  action: "tables";
  database: NormalizedSqlDatabase;
  selectedBy: SqlDbSelectedBy;
  count: number;
  tables: SqlTableRef[];
}

interface SqlDescribeData {
  action: "describe";
  database: NormalizedSqlDatabase;
  selectedBy: SqlDbSelectedBy;
  schema: string;
  table: string;
  columns: SqlColumn[];
}

type SqlData = SqlTablesData | SqlDescribeData | SqlDbsData | SqlRunData | SqlExplainData | SqlUpdateData | SqlInsertData | SqlModifyData | SqlTuiData | SqlBatchData;

/** SQL writes follow the AD write contract (confirm, or --yes; --yes mandatory in --llm). */
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
      ...(args.statements ? [["Statements", String(args.statements.length)] as [string, string]] : []),
      ["Query", args.query ?? args.statements?.join(";\n") ?? ""],
    ],
  });
  logIntent("POST", "/rest/api/automation/chain/test", { sql: action, db: database.nickname });
}

const DB_FLAG = { db: { type: "string" } } as const;
const RAW_FLAG = { raw: { type: "boolean" } } as const;
const SQL_CODES = { UNKNOWN_SUBCOMMAND: "INVALID_SQL_SUBCOMMAND", MISSING_SUBCOMMAND: "INVALID_SQL_SUBCOMMAND" } as const;

// the SQL comes from the argument, `--file <path>` or stdin (`-`): readSqlSource checks there is one.
const QUERY_POSITIONAL = [{ name: "query" }] as const;
const FILE_FLAG = { file: { type: "string" } } as const;

/** The statements in `text` (at least one entry, so an empty input reaches the gates). */
function statementsOf(text: string): string[] {
  const statements = splitSqlStatements(text);
  return statements.length > 0 ? statements : [text];
}

/** Apply a gate to every statement; with several, the error names the statement. */
function gateEach(statements: string[], gate: (sql: string) => void): void {
  statements.forEach((sql, i) => {
    try {
      gate(sql);
    } catch (e) {
      if (!(e instanceof CliError) || statements.length === 1) throw e;
      const details = e.details && typeof e.details === "object" ? e.details : {};
      throw new CliError(`Statement ${i + 1} of ${statements.length}: ${e.message}`, {
        code: e.code,
        details: { ...details, statement: i + 1 },
      });
    }
  });
}

export const args = defineSubcommands(
  {
    dbs: { flags: { ...RAW_FLAG } },
    tables: { flags: { ...DB_FLAG, schema: { type: "string" }, like: { type: "string" } } },
    describe: {
      positionals: [
        { name: "table", required: true, missingCode: "MISSING_SQL_TABLE", missingMessage: "Missing table name. Usage: wi-impl ad sql describe <table|schema.table>" },
      ],
      flags: { ...DB_FLAG },
    },
    run: {
      positionals: QUERY_POSITIONAL,
      flags: { ...DB_FLAG, ...RAW_FLAG, ...FILE_FLAG },
    },
    explain: {
      positionals: QUERY_POSITIONAL,
      flags: {
        ...DB_FLAG,
        ...FILE_FLAG,
        ...RAW_FLAG,
        analyze: { type: "boolean" },
        buffers: { type: "boolean" },
        format: { type: "enum", values: ["text", "json"], default: "text" },
      },
    },
    update: {
      positionals: QUERY_POSITIONAL,
      flags: { ...DB_FLAG, ...RAW_FLAG, ...AD_YES_FLAG, ...FILE_FLAG },
    },
    insert: {
      positionals: QUERY_POSITIONAL,
      flags: { ...DB_FLAG, ...RAW_FLAG, ...AD_YES_FLAG, ...FILE_FLAG },
    },
    modify: {
      positionals: QUERY_POSITIONAL,
      flags: { ...DB_FLAG, ...RAW_FLAG, ...AD_YES_FLAG, ...FILE_FLAG },
    },
    tui: {
      flags: {
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
    command: "wi-impl ad sql",
    codes: SQL_CODES,
    missingMessage: "Missing SQL subcommand. Use one of: run, explain, tables, describe, dbs, tui, update, insert, modify.",
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

/** `sql tables` / `sql describe`: information_schema reads through the read operation. */
async function describeSchema(args: SqlArgs, envDefault: ReturnType<typeof sqlDefaultDb>): Promise<CommandResult<SqlData>> {
  const [dbContext, executionContext] = await Promise.all([resolveSqlDbContext({ requestedDb: args.db, envDefault }), loadSqlExecutionContext()]);
  const database = dbContext.resolution.selected;
  const selectedBy = dbContext.resolution.selectedBy;
  const read = async (query: string) => (await executeSqlReadQuery({ query, database, context: executionContext })).rows;
  const opts = args.schema ?? {};

  if (args.action === "tables") {
    const tables = readTables(await read(buildTablesQuery(opts)));
    return ok({ action: "tables", database, selectedBy, count: tables.length, tables });
  }

  const table = opts.table!;
  const bySchema = readColumns(await read(buildDescribeQuery(table, opts.schema)));
  const where = opts.schema ? `${opts.schema}.${table}` : table;
  if (bySchema.size === 0) {
    const similar = readTables(await read(buildSimilarTablesQuery(table))).map((t) => `${t.schema}.${t.name}`);
    throw new CliError(
      `No table or view '${where}' on '${database.nickname}'.` +
        (similar.length > 0 ? ` Similar: ${similar.join(", ")}.` : " 'wi-impl ad sql tables --like <part>' lists the names."),
      { code: "SQL_TABLE_NOT_FOUND", details: { table, ...(opts.schema ? { schema: opts.schema } : {}), similar } },
    );
  }
  if (bySchema.size > 1) {
    const schemas = [...bySchema.keys()];
    throw new CliError(`'${table}' exists in several schemas (${schemas.join(", ")}): pass <schema>.${table}.`, {
      code: "SQL_TABLE_AMBIGUOUS",
      details: { table, schemas },
    });
  }
  const [schema, columns] = [...bySchema][0]!;
  return ok({ action: "describe", database, selectedBy, schema, table, columns });
}

const BATCH = {
  run: { load: loadSqlExecutionContext, execute: executeSqlReadQuery },
  update: { load: loadSqlUpdateContext, execute: executeSqlUpdate },
  insert: { load: loadSqlInsertContext, execute: executeSqlInsert },
  modify: { load: loadSqlModifyContext, execute: executeSqlModify },
} as const;

/** Read statements of a batch in flight at once. */
const READ_CONCURRENCY = 4;

/**
 * Several statements in one call: the database, the operation and the
 * template load once, then each statement is one POST (a separate process per
 * statement cost ~3 s each). Reads all run, up to READ_CONCURRENCY at a time;
 * writes run in order and stop at the first failure. Any failure makes the
 * envelope SQL_BATCH_FAILED, with every result in `data`.
 */
async function runSqlBatch(
  action: SqlBatchData["action"],
  statements: string[],
  args: SqlArgs,
  envDefault: ReturnType<typeof sqlDefaultDb>,
  outputMode: "human" | "llm",
): Promise<CommandResult<SqlData>> {
  const [dbContext, executionContext] = await Promise.all([
    resolveSqlDbContext({ requestedDb: args.db, envDefault }),
    BATCH[action].load(),
  ]);
  const database = dbContext.resolution.selected;
  if (action !== "run") await confirmSqlWrite(args, action, database, outputMode);

  const runOne = async (query: string, index: number): Promise<SqlBatchResult> => {
    try {
      const { database: _db, query: _q, ...result } = await BATCH[action].execute({ query, database, context: executionContext, raw: args.raw });
      return { index, query, ok: true, ...result };
    } catch (e) {
      // a stopped env fails every statement the same way: report it once.
      if (!(e instanceof CliError) || e.code === "ENV_UNAVAILABLE") throw e;
      const { database: _db, query: _q, ...details } = (e.details && typeof e.details === "object" ? e.details : {}) as Record<string, unknown>;
      return { index, query, ok: false, error: { code: e.code, message: e.message, ...(Object.keys(details).length ? { details } : {}) } };
    }
  };

  const results: SqlBatchResult[] = [];
  if (action === "run") {
    // reads are independent: a few in flight at a time, results in input order.
    let next = 0;
    const worker = async () => {
      while (next < statements.length) {
        const i = next++;
        results[i] = await runOne(statements[i]!, i + 1);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, statements.length) }, worker));
  } else {
    let stopped = false;
    for (const [i, query] of statements.entries()) {
      if (stopped) {
        results.push({ index: i + 1, query, ok: false, notRun: true });
        continue;
      }
      const result = await runOne(query, i + 1);
      results.push(result);
      stopped = !result.ok;
    }
  }

  const failed = results.filter((r) => !r.ok);
  const data: SqlBatchData = {
    action,
    batch: true,
    database,
    selectedBy: dbContext.resolution.selectedBy,
    statementCount: statements.length,
    okCount: results.length - failed.length,
    failedCount: failed.length,
    results,
  };
  if (failed.length === 0) return ok(data);
  const first = failed.find((r) => r.error)!;
  const notRun = failed.filter((r) => r.notRun).length;
  return failWithData(
    "SQL_BATCH_FAILED",
    `Statement ${first.index} of ${statements.length} failed: ${first.error!.message}` +
      (notRun ? ` (${notRun} later statement${notRun === 1 ? "" : "s"} not run)` : ""),
    data,
  );
}

const command: CommandModule<SqlArgs, SqlData> = {
  // `tui` can start in, or switch to, update/insert/modify mode: always a write (explicit --env).
  writes: (a) => a.action === "update" || a.action === "insert" || a.action === "modify" || a.action === "tui",
  helpFor: (help, argv) => subcommandHelp(help, argv, "wi-impl ad sql"),
  parseArgs(argv) {
    const parsed = args.parse(argv);

    switch (parsed.subcommand) {
      case "tables":
        return { action: "tables", raw: false, db: parsed.flags.db, schema: { schema: parsed.flags.schema, like: parsed.flags.like } };
      case "describe":
        return { action: "describe", raw: false, db: parsed.flags.db, schema: parseTableName(parsed.positionals.table) };
      case "dbs":
        return { action: "dbs", raw: parsed.flags.raw };
      case "run": {
        // refuse anything but read statements before any network call.
        const statements = statementsOf(readSqlSource("run", parsed.positionals.query, parsed.flags.file));
        gateEach(statements, (sql) => {
          assertReadOnlySql(sql);
          assertNoParameterMarkers(sql, "sql run");
        });
        const target = statements.length === 1 ? { query: statements[0]! } : { statements };
        return { action: "run", ...target, db: parsed.flags.db, raw: parsed.flags.raw };
      }
      case "explain": {
        // with --analyze the statement must pass the read-only gate (ANALYZE really executes it);
        // plain EXPLAIN only plans, so a write is checked on the built EXPLAIN below.
        const statement = readSqlSource("explain", parsed.positionals.query, parsed.flags.file);
        if (/^explain\b/i.test(checkReadOnlySql(statement).normalized)) {
          throw new CliError("Pass the statement without EXPLAIN; use --analyze / --buffers / --format for the options.", {
            code: "SQL_EXPLAIN_NESTED",
          });
        }
        const f = parsed.flags;
        if (f.analyze) assertReadOnlySql(statement, "sql explain");
        if (f.buffers && !f.analyze) {
          throw new CliError("--buffers needs --analyze (buffer counts come from executing the statement).", { code: "SQL_EXPLAIN_BUFFERS_NEEDS_ANALYZE" });
        }
        const explain = { statement, analyze: f.analyze, buffers: f.buffers, format: f.format as "text" | "json" };
        const query = buildExplainSql(statement, explain);
        assertReadOnlySql(query, "sql explain");
        assertNoParameterMarkers(query, "sql explain");
        return { action: "explain", query, explain, db: f.db, raw: f.raw };
      }
      case "update":
      case "insert":
      case "modify": {
        // refuse an empty, comment-only or wrong-kind statement before any network call.
        const kind = parsed.subcommand;
        const statements = statementsOf(readSqlSource(kind, parsed.positionals.query, parsed.flags.file));
        gateEach(statements, (sql) => {
          assertWriteSql(sql, kind);
          if (kind !== "modify") assertNoParameterMarkers(sql, `sql ${kind}`);
        });
        return {
          action: kind,
          ...(statements.length === 1 ? { query: statements[0]! } : { statements }),
          db: parsed.flags.db,
          raw: parsed.flags.raw,
          yes: parsed.flags.yes,
        };
      }
      case "tui":
        return { action: "tui", raw: false, db: parsed.flags.db, tui: parseTuiOptions(parsed.flags) };
    }
  },
  async execute(args, context) {
    const envDefault = sqlDefaultDb(context.env.name);

    if (args.statements && (args.action === "run" || args.action === "update" || args.action === "insert" || args.action === "modify")) {
      return runSqlBatch(args.action, args.statements, args, envDefault, context.outputMode);
    }

    if (args.action === "tables" || args.action === "describe") {
      return describeSchema(args, envDefault);
    }

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
    const data = envelope.data as SqlData;
    if (data && "batch" in data) {
      ui.section(`${data.okCount} of ${data.statementCount} statements ran against '${data.database.nickname}'`);
      for (const r of data.results) {
        ui.section(`Statement ${r.index}${r.ok ? "" : r.notRun ? " (not run)" : " (failed)"}`);
        ui.text(r.query);
        if (r.error) ui.text(r.error.message);
        else if (r.rows) {
          if (r.rows.length === 0) ui.text("(No rows returned)");
          else ui.object(r.rows);
        } else if (r.rowsAffected !== undefined) ui.text(`Rows affected: ${r.rowsAffected}`);
      }
      return;
    }
    if (!envelope.ok) return;

    if (data.action === "tables") {
      ui.success(`${data.count} tables and views on '${data.database.nickname}'.`);
      ui.table(["Schema", "Name", "Type"], data.tables.map((t) => [t.schema, t.name, t.type ?? ""]));
      return;
    }

    if (data.action === "describe") {
      ui.success(`${data.schema}.${data.table} on '${data.database.nickname}': ${data.columns.length} columns.`);
      ui.table(
        ["Column", "Type", "Nullable", "Default", "PK"],
        data.columns.map((c) => [c.name, c.type, c.nullable ? "yes" : "no", c.default ?? "", c.primaryKey ? "yes" : ""]),
      );
      return;
    }

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
