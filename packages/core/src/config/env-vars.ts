// Which process env vars belz trusts.
//
// Bun auto-loads `.env*` files from the current directory into process.env —
// in dev mode AND in the compiled binary (Bun 1.2.x has no build flag to turn
// that off). A stray `.env` in whatever directory the user happens to run
// `belz` from must not be able to redirect an environment URL or inject
// credentials. So:
//   1. belz only reads its own `BELZ_*` variables (the legacy per-project /
//      TEAMWORK_* / API_* variables are gone; `belz setup --from-env` still
//      imports them explicitly into config.json), and
//   2. a BELZ_* value that is identical to one in a cwd `.env*` file Bun would
//      have loaded is treated as dotenv-injected and ignored.

import { existsSync, readFileSync } from "fs";
import { join } from "path";

const DOTENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];

/** Minimal dotenv parser (KEY=VALUE, optional `export`, quotes). */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m || !m[1]) continue;
    let value = m[2] ?? "";
    const q = value[0];
    if ((q === '"' || q === "'" || q === "`") && value.endsWith(q) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** Keys (with values) that cwd dotenv files define. */
function dotenvValues(cwd: string): Record<string, string> {
  const all: Record<string, string> = {};
  for (const name of DOTENV_FILES) {
    const p = join(cwd, name);
    try {
      if (!existsSync(p)) continue;
      Object.assign(all, parseDotEnv(readFileSync(p, "utf8")));
    } catch {
      /* unreadable: ignore */
    }
  }
  return all;
}

/**
 * Every non-empty process env var except those a cwd `.env*` file injected
 * (same key, same value). `dropped` names the ignored keys. Used by
 * `belz setup --from-env`, which imports TEAMWORK_* keys too
 * and must not persist a hostile cwd `.env` into config.json.
 */
export function withoutDotenvInjected(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): { values: Record<string, string>; dropped: string[] } {
  let dotenv: Record<string, string> | null = null;
  const values: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    dotenv ??= dotenvValues(cwd);
    if (Object.hasOwn(dotenv, key) && dotenv[key] === value) {
      dropped.push(key);
      continue;
    }
    values[key] = value;
  }
  return { values, dropped: dropped.sort() };
}

/**
 * The BELZ_* env vars belz honours: explicitly exported ones only. A value
 * that equals what a cwd `.env*` file defines for the same key is dropped.
 */
export function trustedBelzEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Record<string, string> {
  const belzOnly: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (key.startsWith("BELZ_")) belzOnly[key] = value;
  return withoutDotenvInjected(belzOnly, cwd).values;
}
