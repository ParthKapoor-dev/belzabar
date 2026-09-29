// Assertion helpers for coded CliErrors (the error contract every command test
// checks), plus a JSON fixture loader.

import { readFileSync } from "fs";
import { join } from "path";
import { CliError } from "../command";

/** The CliError `fn` throws. Fails the test when it does not throw, or throws something else. */
export function thrownCliError(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error("expected a CliError");
}

/** The code of the CliError `fn` throws. */
export function errorCode(fn: () => unknown): string {
  return thrownCliError(fn).code;
}

/** The CliError a promise rejects with. Fails when it resolves or rejects with something else. */
export async function caughtCliError(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error("expected a CliError");
}

/** The code of the CliError a promise rejects with. */
export async function rejectionCode(p: Promise<unknown>): Promise<string> {
  return (await caughtCliError(p)).code;
}

/**
 * A synchronous JSON fixture reader for one directory:
 * `const load = jsonFixtures(FIX); load("x.json")`, or with a suffix,
 * `jsonFixtures(REAL, ".json")("<id>")`. Fixtures are untyped wire JSON;
 * pass the type you expect.
 */
export function jsonFixtures(dir: string, suffix = ""): <T = any>(name: string) => T {
  return <T>(name: string): T => JSON.parse(readFileSync(join(dir, `${name}${suffix}`), "utf8")) as T;
}
