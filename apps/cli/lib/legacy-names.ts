// Moves an install made before the rename (belz → wi-impl) to the new names, once.
//
// A pre-rename binary updates itself in place, so after the update the new code runs as
// `<dir>/belz` and its data is still in `~/.belz`. On its first run a compiled binary:
//   • renames itself to `<dir>/wi-impl` and leaves `belz` as an alias (a symlink; on Windows a
//     `belz.cmd` next to `wi-impl.exe`), and
//   • moves `~/.belz` to `~/.wi-impl`, leaving `~/.belz` as a symlink to it (not on Windows).
// Both steps are skipped when anything is already in place, and failures (a read-only install
// dir, a race with another run) only leave the old names working.
//
// bin/cli.ts imports this module first: it runs before @belzabar/core resolves the data dir,
// so this module imports nothing from core.

import { existsSync, lstatSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

const isWindows = process.platform === "win32";

/** Move `<home>/.belz` to `<home>/.wi-impl` unless a data dir is chosen or already there. */
export function migrateLegacyHome(env: NodeJS.ProcessEnv, home: string, windows = isWindows): string | null {
  if (env.WI_IMPL_HOME || env.BELZ_HOME) return null;
  const to = join(home, ".wi-impl");
  const from = join(home, ".belz");
  if (existsSync(to) || !existsSync(from) || lstatSync(from).isSymbolicLink()) return null;
  renameSync(from, to);
  if (!windows) {
    try {
      symlinkSync(".wi-impl", from); // older binaries (a rollback) still find their data
    } catch {
      /* the move is what matters */
    }
  }
  return to;
}

/**
 * Rename the binary `exe` from `belz` to `wi-impl` and leave `belz` as an alias. Returns the new
 * path, or null when `exe` is not a pre-rename binary file (already migrated, or run via the alias).
 */
export function migrateLegacyBinary(exe: string, windows = isWindows): string | null {
  const ext = windows ? ".exe" : "";
  if (basename(exe) !== `belz${ext}` || !lstatSync(exe).isFile()) return null;
  const dir = dirname(exe);
  const target = join(dir, `wi-impl${ext}`);
  if (existsSync(target)) return null; // installed side by side: leave both alone
  renameSync(exe, target); // a running binary may be renamed (Windows too)
  if (existsSync(`${exe}.prev`)) renameSync(`${exe}.prev`, `${target}.prev`);
  if (windows) writeFileSync(join(dir, "belz.cmd"), `@"%~dp0wi-impl.exe" %*\r\n`);
  else {
    rmSync(exe, { force: true });
    symlinkSync(`wi-impl${ext}`, exe);
  }
  return target;
}

/** Same test as core's isCompiledEntry (not imported: see the header). */
function isCompiled(entry: string | undefined): boolean {
  return !!entry && (entry.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(entry));
}

if (isCompiled(process.argv[1])) {
  const moved: string[] = [];
  try {
    const bin = migrateLegacyBinary(process.execPath);
    if (bin) moved.push(`installed as ${bin}`);
  } catch {
    /* keep running as belz */
  }
  try {
    const dir = migrateLegacyHome(process.env, homedir());
    if (dir) moved.push(`data moved to ${dir}`);
  } catch {
    /* keep reading ~/.belz */
  }
  if (moved.length > 0) process.stderr.write(`belz is now wi-impl: ${moved.join("; ")}. \`belz\` keeps working.\n`);
}
