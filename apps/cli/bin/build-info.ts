// Build identity for `wi-impl --version`. Imported with `{ type: "macro" }` from
// bin/options.ts, so Bun evaluates it at bundle time: the compiled binary embeds
// the SHA it was built from, and dev runs (`bun bin/cli.ts`) compute it on load.
import { readFileSync } from "fs";
import { join } from "path";

function git(args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd: import.meta.dir, stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

export function buildInfo(): { version: string; sha: string; dirty: boolean; builtAt: string } {
  let version = "0.0.0";
  try {
    version = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version ?? version;
  } catch { /* keep default */ }
  const sha = git(["rev-parse", "--short", "HEAD"]) ?? "unknown";
  const dirty = (git(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "";
  return { version, sha, dirty, builtAt: new Date().toISOString().slice(0, 10) };
}
