// Reading a user-supplied JSON file (--file, --spec, case files, ledgers) with
// the caller's own error codes and wording for "cannot read" vs "not JSON".

import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import type { CliError } from "./command";

export interface JsonInputErrors {
  /** The file could not be read; `missing` is true for ENOENT. */
  unreadable: (err: unknown, missing: boolean) => CliError;
  /** The file was read but is not valid JSON. */
  invalid: (err: unknown) => CliError;
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

function parse(text: string, errors: JsonInputErrors): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw errors.invalid(err);
  }
}

/** Read and parse a JSON file; every failure is the caller's CliError. */
export async function readJsonInput(path: string, errors: JsonInputErrors): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw errors.unreadable(err, isMissing(err));
  }
  return parse(text, errors);
}

/** Synchronous readJsonInput. */
export function readJsonInputSync(path: string, errors: JsonInputErrors): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw errors.unreadable(err, isMissing(err));
  }
  return parse(text, errors);
}
