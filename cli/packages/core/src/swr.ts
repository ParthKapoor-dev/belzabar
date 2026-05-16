import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { vlog } from "./verbose";

/** How long a refresh lock suppresses duplicate background refreshes. */
const REFRESH_LOCK_TTL_MS = 30_000;

function lockPath(cacheDir: string, key: string): string {
  return join(cacheDir, ".refresh", `${key}.lock`);
}

/** True when no fresh refresh lock exists for this key (i.e. a refresh may run). */
export function shouldRefresh(cacheDir: string, key: string): boolean {
  try {
    const path = lockPath(cacheDir, key);
    if (!existsSync(path)) return true;
    const ts = Number(readFileSync(path, "utf8").trim());
    if (!Number.isFinite(ts)) return true;
    return Date.now() - ts > REFRESH_LOCK_TTL_MS;
  } catch {
    return true;
  }
}

function markRefreshing(cacheDir: string, key: string): void {
  try {
    mkdirSync(join(cacheDir, ".refresh"), { recursive: true });
    writeFileSync(lockPath(cacheDir, key), String(Date.now()));
  } catch {
    /* best-effort — a missing lock just allows a duplicate refresh */
  }
}

/**
 * Best-effort stale-while-revalidate refresh. Re-invokes the current `belz`
 * command with `--force` as a detached background process so it outlives this
 * short-lived CLI process and rewrites the cache for the next invocation.
 *
 * Stdio is discarded so the child can never corrupt the parent's `--llm` JSON
 * (or interleave with its table output). A per-key lock under
 * `<cacheDir>/.refresh/` suppresses duplicate concurrent refreshes. Never throws.
 */
export function triggerDetachedRefresh(cacheDir: string, key: string): void {
  try {
    if (!shouldRefresh(cacheDir, key)) {
      vlog(`SWR REFRESH SKIP ${key} (lock active)`);
      return;
    }
    const [bin, ...rest] = process.argv;
    if (!bin) return;
    markRefreshing(cacheDir, key);
    const args = rest.includes("--force") ? rest : [...rest, "--force"];
    const child = spawn(bin, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    vlog(`SWR REFRESH SPAWN ${key}`);
  } catch (e) {
    vlog(`SWR REFRESH ERROR ${key}`, { error: String(e) });
  }
}
