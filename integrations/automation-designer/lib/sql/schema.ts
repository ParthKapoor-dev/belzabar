// `wi-impl ad sql tables` / `describe <table>`: the schema questions agents
// otherwise ask with hand-written information_schema queries (and guessed
// names). The statements are plain reads through the same read gate as
// `sql run`; names and patterns go in as quoted literals.

import { CliError } from "@belzabar/core";

/** Schemas left out unless asked for by name. */
const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema')";

/** A SQL string literal (`'` doubled). */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `schema.table` or `table` (a quoted part may hold a dot: `"my.schema".t`). */
export function parseTableName(input: string): { schema?: string; table: string } {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "." && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const names = parts.map((p) => p.trim());
  if (names.length > 2 || names.some((n) => !n)) {
    throw new CliError(`'${input}' is not a table name: use <table> or <schema>.<table>.`, { code: "SQL_INVALID_TABLE_NAME" });
  }
  return names.length === 2 ? { schema: names[0], table: names[1]! } : { table: names[0]! };
}

/** `sql tables`: every table and view, optionally in one schema / matching a pattern (ILIKE; no `%` = contains). */
export function buildTablesQuery(opts: { schema?: string; like?: string } = {}): string {
  const where = [opts.schema ? `table_schema = ${sqlLiteral(opts.schema)}` : `table_schema not in ${SYSTEM_SCHEMAS}`];
  if (opts.like) where.push(`table_name ilike ${sqlLiteral(opts.like.includes("%") ? opts.like : `%${opts.like}%`)}`);
  return (
    "select table_schema as schema, table_name as name, table_type as type " +
    `from information_schema.tables where ${where.join(" and ")} order by 1, 2`
  );
}

/** `sql describe`: the columns of one table or view, in order, with the primary-key flag. */
export function buildDescribeQuery(table: string, schema?: string): string {
  const where = [`c.table_name = ${sqlLiteral(table)}`, schema ? `c.table_schema = ${sqlLiteral(schema)}` : `c.table_schema not in ${SYSTEM_SCHEMAS}`];
  return (
    "select c.table_schema as schema, c.column_name as name, " +
    "case when c.data_type in ('ARRAY', 'USER-DEFINED') then c.udt_name else c.data_type end as type, " +
    "c.is_nullable as nullable, c.column_default as default_value, " +
    "case when exists (select 1 from information_schema.table_constraints tc " +
    "join information_schema.key_column_usage k on k.constraint_name = tc.constraint_name " +
    "and k.table_schema = tc.table_schema and k.table_name = tc.table_name " +
    "where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema " +
    "and tc.table_name = c.table_name and k.column_name = c.column_name) then 'YES' else 'NO' end as primary_key " +
    `from information_schema.columns c where ${where.join(" and ")} order by c.table_schema, c.ordinal_position`
  );
}

/** Tables whose name contains `table` (case-insensitive): the suggestions for a name that does not exist. */
export function buildSimilarTablesQuery(table: string): string {
  return (
    "select table_schema as schema, table_name as name from information_schema.tables " +
    `where table_schema not in ${SYSTEM_SCHEMAS} and table_name ilike ${sqlLiteral(`%${table}%`)} order by 2 limit 10`
  );
}

export interface SqlTableRef {
  schema: string;
  name: string;
  type?: string;
}

export interface SqlColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

export function readTables(rows: unknown[]): SqlTableRef[] {
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return { schema: str(row.schema), name: str(row.name), ...(row.type != null ? { type: str(row.type) } : {}) };
  });
}

/** The describe rows grouped by schema (a table name may exist in several). */
export function readColumns(rows: unknown[]): Map<string, SqlColumn[]> {
  const bySchema = new Map<string, SqlColumn[]>();
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    const list = bySchema.get(str(row.schema)) ?? [];
    list.push({
      name: str(row.name),
      type: str(row.type),
      nullable: str(row.nullable).toUpperCase() === "YES",
      default: row.default_value == null ? null : str(row.default_value),
      primaryKey: str(row.primary_key).toUpperCase() === "YES",
    });
    bySchema.set(str(row.schema), list);
  }
  return bySchema;
}
