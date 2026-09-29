import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { vlog } from "./verbose";
import { normalizeCacheKey } from "./cache";

/** How long a refresh lock suppresses duplicate background refreshes. */
const REFRESH_LOCK_TTL_MS = 30_000;

/** Lock files older than this are pruned when a new refresh is marked. */
const STALE_LOCK_PRUNE_MS = 24 * 60 * 60 * 1000;

/** Flags that must not be replayed by a background refresh (side effects). */
const REFRESH_STRIP_FLAGS = new Set(["--open", "-o"]);

function lockPath(cacheDir: string, key: string): string {
  return join(cacheDir, ".refresh", `${normalizeCacheKey(key)}.lock`);
}

/** True when running from a `bun build --compile` binary (argv[1] is a virtual bunfs path). */
function isCompiledEntry(entry: string | undefined): boolean {
  return !!entry && (entry.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(entry));
}

/**
 * Build the command that re-runs the current invocation with `--force`.
 *
 * - Dev (`bun bin/cli.ts ad show X`): argv = [bun, script, ...args] → run
 *   `argv[0]` with `[script, ...args]`.
 * - Compiled binary: argv = ["bun", "/$bunfs/root/belz", ...args] — "bun" is
 *   not the real executable, so run `execPath` (the belz binary) with `args`.
 *
 * Side-effectful flags (`--open`/`-o`) are stripped so the refresh never opens
 * a browser a second time.
 */
export function buildRefreshCommand(
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath,
): { bin: string; args: string[] } | null {
  let bin: string | undefined;
  let rest: string[];
  if (isCompiledEntry(argv[1])) {
    bin = execPath;
    rest = argv.slice(2);
  } else {
    bin = argv[0];
    rest = argv.slice(1);
  }
  if (!bin) return null;
  const args = rest.filter((a) => !REFRESH_STRIP_FLAGS.has(a));
  if (!args.includes("--force")) args.push("--force");
  return { bin, args };
}

function pruneStaleLocks(dir: string): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".lock")) continue;
      const p = join(dir, name);
      if (now - statSync(p).mtimeMs > STALE_LOCK_PRUNE_MS) unlinkSync(p);
    }
  } catch {
    /* best-effort */
  }
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
    const dir = join(cacheDir, ".refresh");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    pruneStaleLocks(dir);
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
    const cmd = buildRefreshCommand();
    if (!cmd) return;
    markRefreshing(cacheDir, key);
    const child = spawn(cmd.bin, cmd.args, {
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
