// Which process env vars belz trusts.
//
// Bun auto-loads `.env*` files from the current directory into process.env —
// in dev mode AND in the compiled binary (Bun 1.2.x has no build flag to turn
// that off). A stray `.env` in whatever directory the user happens to run
// `belz` from must not be able to redirect an environment URL or inject
// credentials. So:
//   1. belz only reads its own `WI_IMPL_*` variables (the legacy per-project /
//      TEAMWORK_* / API_* variables are gone; `belz setup --from-env` still
//      imports them explicitly into config.json), and
//   2. a WI_IMPL_* value that is identical to one in a cwd `.env*` file Bun would
//      have loaded is treated as dotenv-injected and ignored.
//
// Releases before the rename read `BELZ_*`: each `BELZ_X` still counts as `WI_IMPL_X` when
// `WI_IMPL_X` is not set (withLegacyNames), so existing shells, scripts and env files keep working.

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

const PREFIX = "WI_IMPL_";
/** The prefix of the same variables before the rename. */
const LEGACY_PREFIX = "BELZ_";

/** `values` plus `WI_IMPL_X` for each legacy `BELZ_X` whose new name is not set. */
export function withLegacyNames(values: Record<string, string>): Record<string, string> {
  const out = { ...values };
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const name = PREFIX + key.slice(LEGACY_PREFIX.length);
    if (out[name] === undefined) out[name] = value;
  }
  return out;
}

/**
 * The WI_IMPL_* env vars belz honours (legacy BELZ_* names included): explicitly exported ones
 * only. A value that equals what a cwd `.env*` file defines for the same key is dropped.
 */
export function trustedBelzEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Record<string, string> {
  const belzOnly: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (key.startsWith(PREFIX) || key.startsWith(LEGACY_PREFIX)) belzOnly[key] = value;
  const trusted = withLegacyNames(withoutDotenvInjected(belzOnly, cwd).values);
  return Object.fromEntries(Object.entries(trusted).filter(([key]) => key.startsWith(PREFIX)));
}

/**
 * True when belz runs inside a coding agent's shell, where the default output is the `--llm`
 * envelope: `WI_IMPL_AGENT=1`, or Claude Code's `CLAUDECODE=1` (the one non-WI_IMPL_ variable read,
 * and only when a cwd `.env*` did not inject it). `WI_IMPL_AGENT=0` turns the detection off.
 */
export function inAgentSession(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): boolean {
  const flag = trustedBelzEnv(env, cwd).WI_IMPL_AGENT;
  if (flag !== undefined) return flag === "1";
  return withoutDotenvInjected({ CLAUDECODE: env.CLAUDECODE }, cwd).values.CLAUDECODE === "1";
}
