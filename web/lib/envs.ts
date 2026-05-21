// Environment handling shared by the API routes.
//
// The CLI is the source of truth for which environments exist (built-ins +
// whatever the user added to `~/.belz/config.json`). The web routes shell out
// to `belz <cmd> --env <env>`, and `belz` itself rejects an unknown env — so
// these routes only need to (1) guard the value's *format* to keep it a clean
// CLI argument, and (2) default sensibly when none is supplied. We deliberately
// do NOT hardcode an env allowlist here: that's what kept the tooling
// NSM-only. Any well-formed env a user has configured (e.g. `ys-qa`) flows
// straight through to the CLI.

/** Env slugs are lowercase, start with a letter, and only use [a-z0-9-]. */
const ENV_SLUG = /^[a-z][a-z0-9-]{1,40}$/;

/** Default env when the caller omits one or sends something malformed. */
export const DEFAULT_ENV = "nsm-dev";

/**
 * Coerce an arbitrary request value into a safe env slug to pass to `belz`.
 * Returns {@link DEFAULT_ENV} when the input is missing or not a clean slug.
 */
export function resolveEnv(input: unknown, fallback: string = DEFAULT_ENV): string {
  if (typeof input !== "string") return fallback;
  const value = input.trim().toLowerCase();
  return ENV_SLUG.test(value) ? value : fallback;
}

export interface KnownEnv {
  name: string;
  /** Hostname of the env's base URL (e.g. `yieldsec.qa.expertly.cloud`). */
  host: string;
  baseUrl: string;
  project: string;
  active: boolean;
}
