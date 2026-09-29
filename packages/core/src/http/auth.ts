// Expertly (AD/PD) sessions: per-env JWT stored in ~/.belz/sessions/<env>.json.
//
// - login() is single-flight per env: concurrent callers (PD recursive show,
//   AD bulk reads, release matrix) share one POST /do/login instead of racing
//   on the session file.
// - Session files are written atomically with mode 0600.
// - Failures are coded CliErrors: AUTH_MISSING_CREDENTIALS, AUTH_FAILED,
//   AUTH_NO_TOKEN; response bodies are summarised + redacted.

import { join } from "path";
import { readFileSync } from "fs";
import { Config, BELZ_CONFIG_DIR, writeSecureJson } from "../config";
import { CliError } from "../command";
import type { AuthSession } from "../types";
import { vlog } from "../verbose";
import { lifecycle } from "../ui";
import { defaultTimeoutMs, httpRequest, singleFlight } from "./transport";
import { readBodySummary } from "./errors";

const SESSION_DIR = join(BELZ_CONFIG_DIR, "sessions");

function sessionFilePath(envName: string): string {
  return join(SESSION_DIR, `${envName}.json`);
}

function activeEnvName(): string {
  return Config.activeEnv.name;
}

async function saveSession(session: AuthSession, envName: string = activeEnvName()): Promise<void> {
  writeSecureJson(sessionFilePath(envName), session);
}

export async function loadSession(envName: string = activeEnvName()): Promise<AuthSession | null> {
  const path = sessionFilePath(envName);
  try {
    const session = JSON.parse(readFileSync(path, "utf8")) as AuthSession;
    if (session && typeof session.token === "string" && session.token) {
      vlog(`SESSION HIT ${envName}`, { path });
      return session;
    }
    vlog(`SESSION EMPTY ${envName}`, { path });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") vlog(`SESSION MISS ${envName}`, { path });
    else vlog(`SESSION ERROR ${envName}`, { path, error: String(e) });
  }
  return null;
}

/** Decode a JWT's `exp` (seconds since epoch), or null when the token is not a JWT / has no exp. */
export function jwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True when the token is a JWT whose `exp` is within `skewSeconds` of now (or past). Non-JWTs: false. */
export function isTokenExpired(token: string, skewSeconds = 30, nowMs = Date.now()): boolean {
  const exp = jwtExpiry(token);
  if (exp === null) return false;
  return exp * 1000 <= nowMs + skewSeconds * 1000;
}

function extractToken(bodyText: string, headers: Headers): string {
  try {
    const json = JSON.parse(bodyText);
    if (json && typeof json.token === "string" && json.token) return json.token;
  } catch {
    /* not JSON */
  }
  if (bodyText.trim().split(".").length === 3 && !/\s/.test(bodyText.trim())) return bodyText.trim();
  const authHeader = headers.get("authorization");
  if (authHeader) {
    const m = authHeader.match(/^Bearer\s+(\S+)/i);
    return m?.[1] ?? authHeader;
  }
  return "";
}

const loginFlight = singleFlight<AuthSession>();

async function doLogin(envName: string): Promise<AuthSession> {
  // Config getters target the ACTIVE env; login is always for the active env
  // at call time (envName is the single-flight key).
  const baseUrl = Config.cleanBaseUrl;
  const loginId = Config.loginId;
  const password = Config.password;
  if (!loginId || !password) {
    throw new CliError(
      `Missing credentials for environment '${envName}'. Run 'belz setup' or 'belz config edit' to add them.`,
      { code: "AUTH_MISSING_CREDENTIALS", details: { env: envName } },
    );
  }

  const url = `${baseUrl}/do/login`;
  const spin = lifecycle.spinner(`Authenticating to ${envName}`);
  spin.start(`Authenticating to ${envName}`);

  let response: Response;
  try {
    response = await httpRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Bun/1.0 (Belzabar CLI)",
      },
      body: JSON.stringify({ loginId, password }),
      // Login is a POST but has no server-side work to "complete": use the read
      // timeout (60 s), not the 300 s write one.
      timeoutMs: defaultTimeoutMs("GET"),
    });
  } catch (err) {
    spin.error(`Authentication failed for ${envName}`);
    if (err instanceof CliError && err.code === "HTTP_TIMEOUT") {
      const timeoutMs = defaultTimeoutMs("GET");
      throw new CliError(
        `Login to ${envName} timed out after ${Math.round(timeoutMs / 1000)}s (raise the limit with BELZ_HTTP_TIMEOUT_MS).`,
        { code: "HTTP_TIMEOUT", details: { env: envName, timeoutMs, mayHaveCompleted: false, retryable: true } },
      );
    }
    throw err;
  }
  vlog(`auth login → ${response.status}`);

  if (!response.ok) {
    const body = await readBodySummary(response, 300);
    spin.error(`Login failed for ${envName} (${response.status})`);
    throw new CliError(`Login failed for ${envName} (HTTP ${response.status})${body ? `: ${body}` : ""}`, {
      code: "AUTH_FAILED",
      details: { env: envName, status: response.status, body },
    });
  }

  const bodyText = await response.text();
  const token = extractToken(bodyText, response.headers);
  if (!token) {
    spin.error("Authentication succeeded but no token was returned");
    throw new CliError(`Login to ${envName} succeeded but no token was found in the response.`, {
      code: "AUTH_NO_TOKEN",
      details: { env: envName },
    });
  }

  const session: AuthSession = { token, refreshToken: response.headers.get("refresh-token") || "" };
  await saveSession(session, envName);
  spin.stop(`Authenticated to ${envName}`);
  return session;
}

/**
 * Log in to the active env and persist the session. Concurrent calls for the
 * same env share one request.
 */
export async function login(): Promise<AuthSession> {
  const envName = activeEnvName();
  return loginFlight(envName, () => doLogin(envName));
}

/** The cached session, or a fresh login when there is none. */
export async function ensureSession(): Promise<AuthSession> {
  return (await loadSession()) ?? (await login());
}

/**
 * Replace a session the server rejected. If another concurrent caller already
 * refreshed it (the stored token differs from `staleToken`), reuse that one;
 * otherwise log in (single-flight).
 */
export async function refreshSession(staleToken: string | null): Promise<AuthSession> {
  const current = await loadSession();
  if (current && staleToken !== null && current.token !== staleToken) return current;
  return login();
}
