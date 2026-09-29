// Client-side read-only gate for `belz ad sql run` (and the TUI read mode).
//
// The server runs `sql run` queries through executeQuery with autocommit, so
// DML/DDL there really commits — and is then reported as a *failure*
// ("No results were returned by the query"). We therefore
// refuse anything but a single read statement before sending it:
//
//   SELECT … | WITH … SELECT … | VALUES … | TABLE … | SHOW …
//   EXPLAIN [ANALYZE] [VERBOSE] <read> | EXPLAIN (option [value], …) <read>
//
// EXPLAIN is judged by its inner statement: the inner statement must
// pass this same gate. That matters because EXPLAIN ANALYZE really executes
// it — `EXPLAIN ANALYZE DELETE …` deletes — so ANALYZE is only allowed in
// EXPLAIN's own option position, never inside the statement.
//
// Comments and string / quoted-identifier / dollar-quoted literals are
// stripped first so neither can hide or fake a keyword. The check is
// deliberately conservative: a bare column named like a DML keyword must be
// double-quoted. It cannot see side effects inside called functions
// (e.g. `select nextval(...)` or a user function that writes).

import { CliError } from "@belzabar/core";

const READ_STARTS = new Set(["select", "with", "values", "table", "show"]);

/** Words that make a statement a write (or execute one) wherever they appear. */
const WRITE_WORDS = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "upsert",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
  "execute",
  "vacuum",
  "reindex",
  "refresh",
  "cluster",
  "lock",
  "into", // SELECT … INTO creates a table
  "analyze", // EXPLAIN ANALYZE executes the statement
  "analyse",
]);

interface ReadOnlyVerdict {
  ok: boolean;
  reason?: string;
  /** Query with comments removed and literals blanked (for diagnostics/tests). */
  normalized: string;
}

/**
 * Remove comments and blank out string literals, quoted identifiers and
 * dollar-quoted bodies. Unterminated literals/comments swallow the rest of
 * the input (and are reported by `checkReadOnlySql`).
 */
export function stripSqlLiterals(sql: string): { text: string; unterminated: boolean } {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];

    // -- line comment
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      out += " ";
      continue;
    }
    // /* block comment */ (Postgres nests them)
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) return { text: out, unterminated: true };
      out += " ";
      continue;
    }
    // 'string' ('' escapes; E'…' also allows backslash escapes)
    if (c === "'") {
      const escapeBackslash = i > 0 && /[eE]/.test(sql[i - 1]!) && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      i++;
      let closed = false;
      while (i < n) {
        if (escapeBackslash && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { text: out, unterminated: true };
      out += "''";
      continue;
    }
    // "quoted identifier"
    if (c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { text: out, unterminated: true };
      out += " qident ";
      continue;
    }
    // $tag$ dollar-quoted $tag$
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) return { text: out, unterminated: true };
        i = end + tag.length;
        out += "''";
        continue;
      }
    }
    out += c;
    i++;
  }
  return { text: out, unterminated: false };
}

export function checkReadOnlySql(sql: string): ReadOnlyVerdict {
  const { text, unterminated } = stripSqlLiterals(sql);
  const normalized = text.trim().replace(/[;\s]+$/, "").trim();
  // the query travels with combineInputs:true, so the server evaluates
  // every `#{…}` (inside literals and comments too) and splices the result into
  // the SQL text before the DB sees it. Nothing after that can be checked here.
  if (sql.includes("#{")) {
    return {
      ok: false,
      reason: "contains SpEL '#{' (the server evaluates it into the SQL text before the DB runs it)",
      normalized,
    };
  }
  if (unterminated) {
    return { ok: false, reason: "unterminated string, identifier or comment", normalized };
  }
  if (normalized.length === 0) return { ok: false, reason: "empty statement", normalized };
  if (normalized.includes(";")) {
    return { ok: false, reason: "multiple statements are not allowed", normalized };
  }
  if (/^explain\b/i.test(normalized)) {
    const ex = splitExplain(normalized);
    if ("reason" in ex) return { ok: false, reason: ex.reason, normalized };
    const inner = checkStatement(ex.inner);
    if (inner) return { ok: false, reason: `EXPLAIN${ex.analyze ? " ANALYZE" : ""} of a statement that ${inner}`, normalized };
    return { ok: true, normalized };
  }
  const reason = checkStatement(normalized);
  return reason ? { ok: false, reason, normalized } : { ok: true, normalized };
}

/** Why a single literal-free, non-EXPLAIN statement is not a read (undefined = it is). */
function checkStatement(normalized: string): string | undefined {
  const words = normalized.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? [];
  const first = words[0];
  if (!first || !READ_STARTS.has(first)) {
    return `starts with '${first ?? normalized.slice(0, 20)}', not SELECT/WITH/VALUES/TABLE/SHOW`;
  }
  const bad = words.find((w) => WRITE_WORDS.has(w));
  if (bad) return `contains '${bad.toUpperCase()}' (a write or executing clause)`;
  return undefined;
}

const EXPLAIN_OPTIONS = new Set([
  "analyze", "analyse", "verbose", "costs", "settings", "generic_plan", "buffers", "serialize",
  "wal", "timing", "summary", "memory", "format",
]);
const EXPLAIN_VALUES = new Set(["true", "false", "on", "off", "1", "0", "text", "json", "xml", "yaml", "none", "binary"]);

interface ExplainParts {
  analyze: boolean;
  /** The explained statement (literals already blanked). */
  inner: string;
}

/**
 * Split a literal-free `EXPLAIN …` into its options and the explained
 * statement: `EXPLAIN [ANALYZE] [VERBOSE] stmt` or `EXPLAIN (opt [val], …) stmt`.
 */
export function splitExplain(normalized: string): ExplainParts | { reason: string } {
  let rest = normalized.replace(/^explain\b/i, "").trimStart();
  let analyze = false;
  if (rest.startsWith("(")) {
    const close = rest.indexOf(")");
    if (close < 0) return { reason: "unclosed EXPLAIN option list" };
    for (const raw of rest.slice(1, close).split(",")) {
      const [name, value, ...more] = raw.trim().toLowerCase().split(/\s+/);
      if (!name || !EXPLAIN_OPTIONS.has(name) || more.length > 0 || (value !== undefined && !EXPLAIN_VALUES.has(value))) {
        return { reason: `unknown EXPLAIN option '${raw.trim()}'` };
      }
      if ((name === "analyze" || name === "analyse") && !["false", "off", "0"].includes(value ?? "true")) analyze = true;
    }
    rest = rest.slice(close + 1).trimStart();
  } else {
    for (;;) {
      const m = /^(analyze|analyse|verbose)\b/i.exec(rest);
      if (!m) break;
      if (m[1]!.toLowerCase() !== "verbose") analyze = true;
      rest = rest.slice(m[0].length).trimStart();
    }
  }
  if (!rest) return { reason: "EXPLAIN without a statement" };
  return { analyze, inner: rest };
}

/** `EXPLAIN [(ANALYZE, BUFFERS, FORMAT JSON)] <statement>` for `ad sql explain`. */
export function buildExplainSql(statement: string, opts: { analyze?: boolean; buffers?: boolean; format?: "text" | "json" } = {}): string {
  const options: string[] = [];
  if (opts.analyze) options.push("ANALYZE");
  if (opts.buffers) options.push("BUFFERS");
  if (opts.format && opts.format !== "text") options.push(`FORMAT ${opts.format.toUpperCase()}`);
  const body = statement.trim().replace(/;\s*$/, "").trim();
  return options.length > 0 ? `EXPLAIN (${options.join(", ")}) ${body}` : `EXPLAIN ${body}`;
}

/** Throw SQL_NOT_READ_ONLY unless `sql` is a single read statement. */
export function assertReadOnlySql(sql: string, command = "sql run"): void {
  const verdict = checkReadOnlySql(sql);
  if (verdict.ok) return;
  throw new CliError(
    `'${command}' only accepts a single read statement (SELECT / WITH … SELECT / VALUES / EXPLAIN [ANALYZE] of a read): ` +
      `${verdict.reason}. Use 'belz ad sql update' (UPDATE/DELETE), 'sql insert' (INSERT) or 'sql modify' (DDL) ` +
      `for writes. If a column name collides with a keyword, double-quote it.`,
    { code: "SQL_NOT_READ_ONLY", details: { reason: verdict.reason } },
  );
}
