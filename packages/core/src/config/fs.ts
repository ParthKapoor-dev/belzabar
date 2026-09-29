// Atomic, private file writes for config and session files (CORE-12).
//
// writeSecureJson writes to a temp file in the same directory (mode 0600),
// fsyncs it, and renames it over the target, so a crash or a concurrent
// writer never leaves a truncated config.json/session file behind, and
// secrets are never world-readable (the old default umask gave 0644).

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync, chmodSync } from "fs";
import { dirname, basename, join } from "path";

let counter = 0;

/** Atomically write `content` to `path` with `mode` (default 0600). Creates the parent dir (0700). */
function writeFileAtomic(path: string, content: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${counter++}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", mode);
    writeSync(fd, content);
    try {
      fsyncSync(fd);
    } catch {
      /* fsync unsupported (some tmpfs): the rename is still atomic */
    }
    closeSync(fd);
    fd = null;
    // openSync's mode is filtered by the umask; force it.
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** writeFileAtomic for JSON (pretty-printed when `pretty`). */
export function writeSecureJson(path: string, value: unknown, options: { pretty?: boolean; mode?: number } = {}): void {
  const text = options.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  writeFileAtomic(path, text, options.mode ?? 0o600);
}

/** chmod `path` to `mode` when it grants group/other access. Never throws; true when changed. */
function tighten(path: string, mode: number): boolean {
  try {
    const st = statSync(path);
    if ((st.mode & 0o077) === 0) return false;
    chmodSync(path, mode);
    return true;
  } catch {
    return false; // missing, or not ours: leave it
  }
}

/**
 * One-time permission repair for the belz home (CORE-R5). The 0600/0700 modes
 * only applied to files written after CORE-12, and `mkdir`'s mode only on
 * create, so older installs kept a 0755 `~/.belz` with 0644 session files
 * holding live JWTs. Tightens: the home and `sessions/`, `cache/` to 0700;
 * `config.json` and every session file to 0600. Cheap (a few stats), never
 * throws, no-op on Windows. Returns the paths it changed.
 */
export function hardenBelzHome(home: string): string[] {
  if (process.platform === "win32") return [];
  const changed: string[] = [];
  const fix = (path: string, mode: number) => {
    if (tighten(path, mode)) changed.push(path);
  };
  fix(home, 0o700);
  fix(join(home, "config.json"), 0o600);
  fix(join(home, "cache"), 0o700);
  const sessions = join(home, "sessions");
  fix(sessions, 0o700);
  let names: string[] = [];
  try {
    names = readdirSync(sessions);
  } catch {
    /* no sessions yet */
  }
  for (const name of names) fix(join(sessions, name), 0o600);
  return changed;
}
