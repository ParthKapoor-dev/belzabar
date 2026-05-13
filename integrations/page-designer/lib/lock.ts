// Lock manager. withLock(pageId, fn) acquires the lock, runs fn, releases in
// finally. If acquire fails (409 — PD_LOCKED), the caller sees the CliError
// with details.body including whatever owner info the server returned; it
// does not attempt to force-release.

import { pdApi } from "./api/index";

export async function withLock<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
  await pdApi.acquireLock(pageId);
  try {
    return await fn();
  } finally {
    try {
      await pdApi.releaseLock(pageId);
    } catch (err) {
      // releaseLock already logs to stderr on non-ok responses; we don't
      // want a release failure to mask the underlying business error.
      process.stderr.write(`⚠️  withLock: release threw after fn: ${String(err)}\n`);
    }
  }
}
