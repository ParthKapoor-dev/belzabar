// PD edit locks.
//
// withLock(pageId, fn) acquires the server lock, runs fn, then invalidates the
// local page cache and releases the lock (finally). A 409 on acquire surfaces
// as PD_LOCKED with the server's owner info; belz never force-releases.
//
// Re-entrant (PD-20): a nested withLock in this process neither acquires nor
// releases. A page recorded by `belz pd lock acquire`
// (~/.belz/pd-locks/<env>.json) is NOT trusted blindly (OTH-R4): the record
// may be stale (expired, released in the UI, taken by someone else), so the
// server lock is still acquired, and it is not released afterwards, so a save
// inside a manual lock does not drop the operator's lock.
// Re-acquiring a lock the signed-in user already holds is an HTTP 400 on the
// wire (verified live, NEW-5); `acquireLock` then reads the page's
// `pageLockDetails.lockedByCurrentUser` and reports `heldByMe`. belz writes
// inside such a lock and never releases it (it is the operator's manual lock,
// another belz run's, or the user's own open PD editor). A lock held by
// anyone else is PD_LOCKED (with the stale-record hint when a manual record
// exists).
//
// Every PD write (save, publish, history restore) runs inside withLock, so the
// local page cache for pageId is invalidated here once fn has run (PD-12).

import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { BELZ_CONFIG_DIR, CliError, Config, writeSecureJson } from "@belzabar/core";
import { pdApi } from "./api/index";
import { invalidatePageCache } from "./cache";

// -------- local record of manually-held locks (`belz pd lock`) ------------

interface LockFile {
  locks: Record<string, { acquiredAt: number }>;
}

function activeEnvName(): string {
  return Config.activeEnv?.name || "default";
}

/** Per-env lock file (PD-9). */
function lockFilePath(env = activeEnvName()): { dir: string; file: string; env: string } {
  const dir = join(BELZ_CONFIG_DIR, "pd-locks");
  return { dir, file: join(dir, `${env}.json`), env };
}

export async function loadLockFile(env = activeEnvName()): Promise<{ env: string; data: LockFile; file: string }> {
  const { dir, file } = lockFilePath(env);
  await mkdir(dir, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as LockFile;
    return { env, file, data: parsed && typeof parsed === "object" && parsed.locks ? parsed : { locks: {} } };
  } catch {
    return { env, file, data: { locks: {} } };
  }
}

/** Atomic 0600 write (OTH-R9: a torn write used to reset every record). */
export async function saveLockFile(file: string, data: LockFile): Promise<void> {
  writeSecureJson(file, data, { pretty: true });
}

/** True when `belz pd lock acquire` recorded this page in the active env. */
async function isManuallyLocked(pageId: string): Promise<boolean> {
  const { data } = await loadLockFile();
  return Object.prototype.hasOwnProperty.call(data.locks, pageId);
}

// -------- withLock ---------------------------------------------------------

const heldInProcess = new Set<string>();

export async function withLock<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${activeEnvName()}\u0000${pageId}`;
  const nested = heldInProcess.has(key);
  if (nested) return runHeld(pageId, null, fn, { release: false });
  const manual = await isManuallyLocked(pageId);
  let outcome: Awaited<ReturnType<typeof pdApi.acquireLock>>;
  try {
    outcome = await pdApi.acquireLock(pageId);
  } catch (err) {
    if (manual && err instanceof CliError && err.code === "PD_LOCKED") {
      throw new CliError(
        `${err.message} \`belz pd lock acquire\` recorded it for you, but that record is stale ` +
          `(the lock expired or was released, and someone else took it). Run \`belz pd lock release ${pageId}\` to drop the record.`,
        { code: "PD_LOCKED", details: { ...(err.details as Record<string, unknown> | undefined), staleLocalRecord: true } },
      );
    }
    throw err;
  }
  heldInProcess.add(key);
  if (!outcome.acquired && !manual) {
    process.stderr.write(
      `ℹ  withLock: you already hold the lock on ${pageId} (another belz run, or the page is open in your PD editor); ` +
        `writing inside it and leaving it held.\n`,
    );
  }
  // Release only a lock this call took: never a manual one, never one already held.
  return runHeld(pageId, key, fn, { release: outcome.acquired && !manual });
}

async function runHeld<T>(pageId: string, key: string | null, fn: () => Promise<T>, opts: { release: boolean }): Promise<T> {
  try {
    return await fn();
  } finally {
    await invalidatePageCache(pageId);
    if (key !== null) {
      heldInProcess.delete(key);
      if (opts.release) {
        try {
          const { released } = await pdApi.releaseLock(pageId);
          if (released !== true) process.stderr.write(`⚠️  withLock: the lock on ${pageId} may still be held (release was refused).\n`);
        } catch (err) {
          // Never let a release failure mask the business result or error.
          process.stderr.write(`⚠️  withLock: release threw after fn: ${String(err)}\n`);
        }
      }
    }
  }
}
