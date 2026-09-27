// Atomic, private file writes for config and session files (CORE-12).
//
// writeSecureJson writes to a temp file in the same directory (mode 0600),
// fsyncs it, and renames it over the target, so a crash or a concurrent
// writer never leaves a truncated config.json/session file behind, and
// secrets are never world-readable (the old default umask gave 0644).

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync, chmodSync } from "fs";
import { dirname, basename, join } from "path";

let counter = 0;

/** Atomically write `content` to `path` with `mode` (default 0600). Creates the parent dir (0700). */
export function writeFileAtomic(path: string, content: string, mode = 0o600): void {
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
