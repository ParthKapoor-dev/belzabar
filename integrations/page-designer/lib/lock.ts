// Lock manager. withLock(pageId, fn) acquires the lock, runs fn, releases in
// finally. If acquire fails (409 — PD_LOCKED), the caller sees the CliError
// with details.body including whatever owner info the server returned; it
// does not attempt to force-release.

//
// Every PD write (save, publish, history restore) runs inside withLock, so the
// local page cache for pageId is invalidated here once fn has run (PD-12).

import { pdApi } from "./api/index";
import { invalidatePageCache } from "./cache";

export async function withLock<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
  await pdApi.acquireLock(pageId);
  try {
    return await fn();
  } finally {
    await invalidatePageCache(pageId);
    try {
      await pdApi.releaseLock(pageId);
    } catch (err) {
      // releaseLock already logs to stderr on non-ok responses; we don't
      // want a release failure to mask the underlying business error.
      process.stderr.write(`⚠️  withLock: release threw after fn: ${String(err)}\n`);
    }
  }
}
