// PD edit locks.
//
// withLock(pageId, fn) acquires the server lock, runs fn, then invalidates the
// local page cache and releases the lock (finally). A 409 on acquire surfaces
// as PD_LOCKED with the server's owner info; belz never force-releases.
//
// Re-entrant (PD-20): when this process already holds the lock (nested
// withLock) or the operator holds it via `belz pd lock acquire` (recorded in
// ~/.belz/pd-locks/<env>.json), withLock neither acquires nor releases — a
// save inside a manual lock no longer drops the operator's lock.
//
// Every PD write (save, publish, history restore) runs inside withLock, so the
// local page cache for pageId is invalidated here once fn has run (PD-12).

import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BELZ_CONFIG_DIR, Config } from "@belzabar/core";
import { pdApi } from "./api/index";
import { invalidatePageCache } from "./cache";

// -------- local record of manually-held locks (`belz pd lock`) ------------

export interface LockFile {
  locks: Record<string, { acquiredAt: number }>;
}

export function activeEnvName(): string {
  return Config.activeEnv?.name || "default";
}

/** Per-env lock file (PD-9). */
export function lockFilePath(env = activeEnvName()): { dir: string; file: string; env: string } {
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

export async function saveLockFile(file: string, data: LockFile): Promise<void> {
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

/** True when `belz pd lock acquire` recorded this page in the active env. */
export async function isManuallyLocked(pageId: string): Promise<boolean> {
  const { data } = await loadLockFile();
  return Object.prototype.hasOwnProperty.call(data.locks, pageId);
}

// -------- withLock ---------------------------------------------------------

const heldInProcess = new Set<string>();

export async function withLock<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${activeEnvName()}\u0000${pageId}`;
  const reentrant = heldInProcess.has(key) || (await isManuallyLocked(pageId));
  if (!reentrant) {
    await pdApi.acquireLock(pageId);
    heldInProcess.add(key);
  }
  try {
    return await fn();
  } finally {
    await invalidatePageCache(pageId);
    if (!reentrant) {
      heldInProcess.delete(key);
      try {
        const released = await pdApi.releaseLock(pageId);
        if (!released) process.stderr.write(`⚠️  withLock: the lock on ${pageId} may still be held (release was refused).\n`);
      } catch (err) {
        // Never let a release failure mask the business result or error.
        process.stderr.write(`⚠️  withLock: release threw after fn: ${String(err)}\n`);
      }
    }
  }
}
