import { CliError, ok, type CommandModule } from "@belzabar/core";
import { fetchMethodDefinition, testMethod } from "../../lib/api";
import { ErrorParser } from "../../lib/error-parser";
import type { RawMethodResponse } from "../../lib/types";
import { fetchSqlDatabases, fetchSqlSelectOperation } from "../../lib/sql/api";
import { buildSqlReadPayload } from "../../lib/sql/payload";
import { parseSqlRunResult } from "../../lib/sql/result";
import { normalizeSqlDatabases, resolveSqlDatabase } from "../../lib/sql/selector";
import type { NormalizedSqlDatabase } from "../../lib/sql/types";

interface SqlArgs {
  action: "run" | "dbs";
  query?: string;
  db?: string;
  raw: boolean;
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

type SqlData = SqlDbsData | SqlRunData;

function parseDbArg(args: string[]): string | undefined {
  const explicit = args.find((arg) => arg.startsWith("--db="));
  if (explicit) {
    const value = explicit.split("=").slice(1).join("=").trim();
    return value || undefined;
  }

  const dbIndex = args.indexOf("--db");
  if (dbIndex !== -1) {
    const value = args[dbIndex + 1];
    if (!value || value.startsWith("-")) {
      throw new CliError("--db requires a database nickname or id.", {
        code: "SQL_DB_ARG_MISSING",
      });
    }

    return value;
  }

  return undefined;
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

const command: CommandModule<SqlArgs, SqlData> = {
  schema: "ad.sql",
  parseArgs(args) {
    const action = args[0];
    if (!action) {
      throw new CliError("Missing SQL subcommand. Use one of: run, dbs.", {
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

    throw new CliError(`Unknown SQL subcommand '${action}'. Use one of: run, dbs.`, {
      code: "INVALID_SQL_SUBCOMMAND",
    });
  },
  async execute(args) {
    const envDefault = process.env.BELZ_SQL_DEFAULT_DB?.trim() || undefined;

    if (args.action === "dbs") {
      const rawDatabases = await fetchSqlDatabases();
      const databases = normalizeSqlDatabases(rawDatabases);

      const data: SqlDbsData = {
        action: "dbs",
        databases,
        defaultResolution: {
          envValue: envDefault,
          fallbackNickname: "NSM_Read_DB",
        },
      };

      if (args.raw) {
        data.raw = {
          databases: rawDatabases,
        };
      }

      return ok(data);
    }

    const [rawDatabases, operation] = await Promise.all([
      fetchSqlDatabases(),
      fetchSqlSelectOperation(),
    ]);

    const databases = normalizeSqlDatabases(rawDatabases);
    const resolution = resolveSqlDatabase(databases, {
      requested: args.db,
      envDefault,
      fallbackNickname: "NSM_Read_DB",
    });

    if (!operation?.methodUUID) {
      throw new CliError("SQL read operation metadata is missing methodUUID.", {
        code: "SQL_SELECT_METADATA_INVALID",
        details: operation,
      });
    }

    const template = (await fetchMethodDefinition(operation.methodUUID)) as RawMethodResponse;
    const payload = buildSqlReadPayload({
      template,
      operation,
      dbAuthId: resolution.selected.id,
      query: args.query as string,
    });

    const formData = new FormData();
    formData.append("body", JSON.stringify(payload));

    const response = await testMethod(formData);
    if (!response.ok) {
      throw new CliError(`SQL execution request failed (${response.status}).`, {
        code: "SQL_EXECUTION_FAILED",
        details: await response.text(),
      });
    }

    const executionResult = await response.json();
    const parsed = parseSqlRunResult(executionResult);

    if (!parsed.success) {
      const failedService = (executionResult?.services || []).find((svc: any) => svc?.executionStatus?.failed);
      const parsedError = failedService?.executionStatus
        ? ErrorParser.parse(failedService.executionStatus)
        : null;

      throw new CliError("SQL query execution failed.", {
        code: "SQL_QUERY_FAILED",
        details: {
          database: resolution.selected,
          query: args.query,
          statusCode: parsed.statusCode,
          error: parsedError,
          executionStatus: executionResult?.executionStatus,
        },
      });
    }

    const data: SqlRunData = {
      action: "run",
      database: resolution.selected,
      selectedBy: resolution.selectedBy,
      query: args.query as string,
      success: true,
      statusCode: parsed.statusCode,
      rows: parsed.rows,
      rowCount: parsed.rowCount,
      executionTime: parsed.executionTime,
    };

    if (args.raw) {
      data.raw = {
        operation,
        payload,
        executionResult,
      };
    }

    return ok(data);
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
  },
};

export default command;
