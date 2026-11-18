// Where an `ad sql` statement comes from: the positional argument, `--file
// <path>`, or stdin (`-` as the argument or as the file). A file or stdin has
// no argument-length limit and may hold several `;`-separated statements.

import { readFileSync } from "fs";
import { CliError } from "@belzabar/core";

interface SqlSourceReaders {
  file: (path: string) => string;
  stdin: () => string;
}

const defaultReaders: SqlSourceReaders = {
  file: (path) => readFileSync(path, "utf-8"),
  stdin: () => readFileSync(0, "utf-8"),
};

/** The SQL text for `wi-impl ad sql <action>`: exactly one of the positional and `--file`. */
export function readSqlSource(
  action: string,
  positional: string | undefined,
  file: string | undefined,
  readers: SqlSourceReaders = defaultReaders,
): string {
  if (positional !== undefined && file !== undefined) {
    throw new CliError(`Pass the SQL either as the argument or with --file, not both.`, { code: "SQL_QUERY_AND_FILE" });
  }
  const from = file ?? positional;
  if (from === undefined) {
    throw new CliError(
      `Missing SQL query argument. Usage: wi-impl ad sql ${action} "<sql>" | --file <path> | - (stdin)`,
      { code: "MISSING_SQL_QUERY" },
    );
  }
  if (from === "-") return readOrFail(() => readers.stdin(), "stdin");
  if (file === undefined) return positional!;
  return readOrFail(() => readers.file(file), file);
}

function readOrFail(read: () => string, where: string): string {
  try {
    return read();
  } catch (e) {
    throw new CliError(`Cannot read SQL from ${where}: ${(e as Error).message}`, { code: "SQL_FILE_UNREADABLE", details: { source: where } });
  }
}
