import { CliError } from "@belzabar/core";
import type {
  NormalizedSqlDatabase,
  SqlDatabaseAuth,
  SqlDbResolutionOptions,
  SqlDbResolutionResult,
} from "./types";

function getFieldValue(auth: SqlDatabaseAuth, fieldName: string): string | null {
  const fields = auth.fields || [];
  const match = fields.find((field) => field.fieldName?.toLowerCase() === fieldName.toLowerCase());
  return match?.fieldValue ?? null;
}

export function normalizeSqlDatabases(databases: SqlDatabaseAuth[]): NormalizedSqlDatabase[] {
  return databases.map((db) => ({
    id: db.id,
    nickname: db.nickname,
    source: getFieldValue(db, "source"),
    host: getFieldValue(db, "host"),
    port: getFieldValue(db, "port"),
    authUsageType: db.authUsageType ?? null,
    derivedAuthType: db.derivedAuthType ?? null,
  }));
}

function matchesById(db: NormalizedSqlDatabase, value: string): boolean {
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) && db.id === numeric;
}

function matchesByNickname(db: NormalizedSqlDatabase, value: string): boolean {
  return db.nickname.toLowerCase() === value.toLowerCase();
}

function findDatabase(databases: NormalizedSqlDatabase[], value: string): NormalizedSqlDatabase | undefined {
  const normalizedValue = value.trim();
  if (!normalizedValue) return undefined;

  return databases.find((db) => matchesById(db, normalizedValue) || matchesByNickname(db, normalizedValue));
}

export function resolveSqlDatabase(
  databases: NormalizedSqlDatabase[],
  options: SqlDbResolutionOptions
): SqlDbResolutionResult {
  if (databases.length === 0) {
    throw new CliError("No SQL databases are available for this environment.", {
      code: "SQL_NO_DATABASES",
    });
  }

  if (options.requested) {
    const selected = findDatabase(databases, options.requested);
    if (!selected) {
      throw new CliError(`Database '${options.requested}' not found.`, {
        code: "SQL_DB_NOT_FOUND",
        details: {
          requested: options.requested,
          available: databases.map((db) => ({ id: db.id, nickname: db.nickname })),
        },
      });
    }

    return {
      selected,
      selectedBy: "--db",
      requested: options.requested,
      envDefault: options.envDefault,
    };
  }

  if (options.envDefault) {
    const selected = findDatabase(databases, options.envDefault);
    if (selected) {
      return {
        selected,
        selectedBy: options.envDefaultSource ?? "env",
        envDefault: options.envDefault,
      };
    }
    if (options.envDefaultSource === "config") {
      // An explicit per-env default that does not exist is a config error, not a silent fallback.
      throw new CliError(
        `Configured sqlDefaultDb '${options.envDefault}' not found in this environment. Fix environments.<env>.sqlDefaultDb in ~/.belz/config.json or pass --db.`,
        {
          code: "SQL_DEFAULT_DB_NOT_FOUND",
          details: { envDefault: options.envDefault, available: databases.map((db) => ({ id: db.id, nickname: db.nickname })) },
        },
      );
    }
  }

  const fallback = databases.find((db) => db.nickname === options.fallbackNickname);
  if (fallback) {
    return {
      selected: fallback,
      selectedBy: "fallback",
      envDefault: options.envDefault,
    };
  }

  throw new CliError(
    `No default SQL database for this environment. Pass --db <nickname|id> (see 'belz ad sql dbs'), or set ` +
      `environments.<env>.sqlDefaultDb in ~/.belz/config.json (or BELZ_SQL_DEFAULT_DB). Fallback '${options.fallbackNickname}' is unavailable.`,
    {
      code: "SQL_DEFAULT_DB_NOT_FOUND",
      details: {
        envDefault: options.envDefault,
        fallbackNickname: options.fallbackNickname,
        available: databases.map((db) => ({ id: db.id, nickname: db.nickname })),
      },
    }
  );
}
