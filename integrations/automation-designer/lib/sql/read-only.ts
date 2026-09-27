// Client-side read-only gate for `belz ad sql run` (and the TUI read mode).
//
// The server runs `sql run` queries through executeQuery with autocommit, so
// DML/DDL there really commits — and is then reported as a *failure*
// ("No results were returned by the query") — smoke-test F2. We therefore
// refuse anything but a single read statement before sending it:
//
//   SELECT … | WITH … SELECT … | VALUES … | TABLE … | EXPLAIN … (without ANALYZE)
//
// Comments and string / quoted-identifier / dollar-quoted literals are
// stripped first so neither can hide or fake a keyword. The check is
// deliberately conservative: a bare column named like a DML keyword must be
// double-quoted. It cannot see side effects inside called functions
// (e.g. `select nextval(...)` or a user function that writes).

import { CliError } from "@belzabar/core";

const READ_STARTS = new Set(["select", "with", "values", "table", "explain"]);

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

export interface ReadOnlyVerdict {
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
  if (unterminated) {
    return { ok: false, reason: "unterminated string, identifier or comment", normalized };
  }
  if (normalized.length === 0) return { ok: false, reason: "empty statement", normalized };
  if (normalized.includes(";")) {
    return { ok: false, reason: "multiple statements are not allowed", normalized };
  }

  const words = (normalized.toLowerCase().match(/[a-z_][a-z0-9_$]*/g) ?? []);
  const first = words[0];
  if (!first || !READ_STARTS.has(first)) {
    return {
      ok: false,
      reason: `statement starts with '${first ?? normalized.slice(0, 20)}', not SELECT/WITH/VALUES/TABLE/EXPLAIN`,
      normalized,
    };
  }
  const bad = words.find(w => WRITE_WORDS.has(w));
  if (bad) {
    return { ok: false, reason: `contains '${bad.toUpperCase()}' (a write or executing clause)`, normalized };
  }
  return { ok: true, normalized };
}

/** Throw SQL_NOT_READ_ONLY unless `sql` is a single read statement. */
export function assertReadOnlySql(sql: string): void {
  const verdict = checkReadOnlySql(sql);
  if (verdict.ok) return;
  throw new CliError(
    `'sql run' only accepts a single read statement (SELECT / WITH … SELECT / VALUES / EXPLAIN without ANALYZE): ` +
      `${verdict.reason}. Use 'belz ad sql update' (UPDATE/DELETE), 'sql insert' (INSERT) or 'sql modify' (DDL) ` +
      `for writes. If a column name collides with a keyword, double-quote it.`,
    { code: "SQL_NOT_READ_ONLY", details: { reason: verdict.reason } },
  );
}
