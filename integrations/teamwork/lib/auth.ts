// Teamwork cookie-session adapter over @belzabar/core/http.
//
// - Credentials come from Config.getTeamwork() (one secret-decode helper,
//   explicit passwordEncoding).
// - Login is single-flight: concurrent 401s during `release matrix` share one
//   POST /launchpad/v1/login.json.
// - The session file is written atomically with mode 0600.

import { join } from "path";
import { readFileSync } from "fs";
import {
  BELZ_CONFIG_DIR,
  CliError,
  Config,
  httpRequest,
  lifecycle,
  readBodySummary,
  singleFlight,
  writeSecureJson,
} from "@belzabar/core";
import type { TeamworkSession } from "./types";

/**
 * The Teamwork site root from config `teamwork.baseUrl` / BELZ_TEAMWORK_URL.
 * There is no default: every team runs its own Teamwork site.
 */
export function teamworkBase(): string {
  const { baseUrl } = Config.getTeamwork();
  if (!baseUrl) {
    throw new CliError(
      'Teamwork site URL is not configured. Set "baseUrl" under "teamwork" in ~/.belz/config.json ' +
        "(e.g. https://<company>.teamwork.com), or export BELZ_TEAMWORK_URL.",
      { code: "TW_CONFIG_MISSING", details: { missing: ["baseUrl"] } },
    );
  }
  return baseUrl;
}

/** Browser URL of a task. */
export function teamworkTaskUrl(taskId: number | string): string {
  return `${teamworkBase()}/app/tasks/${taskId}`;
}

const SESSION_FILE = join(BELZ_CONFIG_DIR, "sessions", "teamwork.json");

export async function saveTeamworkSession(session: TeamworkSession): Promise<void> {
  writeSecureJson(SESSION_FILE, session);
}

async function loadTeamworkSession(): Promise<TeamworkSession | null> {
  try {
    const session = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as TeamworkSession;
    return session && typeof session.twAuth === "string" && session.twAuth ? session : null;
  } catch {
    return null;
  }
}

function extractTwAuth(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const single = response.headers.get("set-cookie");
  for (const cookie of [...cookies, ...(single ? [single] : [])]) {
    const match = cookie.match(/tw-auth=([^;]+)/);
    if (match?.[1]) return match[1];
  }
  return "";
}

async function doLogin(): Promise<TeamworkSession> {
  const { email, password } = Config.getTeamwork();
  if (!email || !password) {
    throw new CliError(
      "Missing Teamwork credentials. Add them with 'belz config edit' (Teamwork), or set BELZ_TEAMWORK_EMAIL / BELZ_TEAMWORK_PASSWORD.",
      { code: "TW_AUTH_MISSING_CREDENTIALS" },
    );
  }

  lifecycle.notice(`[Teamwork] Authenticating as ${email}…`);
  const response = await httpRequest(`${teamworkBase()}/launchpad/v1/login.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Bun/1.0 (Belzabar CLI)",
    },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });

  if (!response.ok) {
    const body = await readBodySummary(response, 300);
    throw new CliError(`Teamwork login failed (HTTP ${response.status})${body ? `: ${body}` : ""}`, {
      code: "TW_AUTH_FAILED",
      details: { status: response.status, body },
    });
  }

  const twAuth = extractTwAuth(response);
  if (!twAuth) {
    throw new CliError("Teamwork login succeeded but no tw-auth cookie was returned.", { code: "TW_AUTH_NO_COOKIE" });
  }

  const session: TeamworkSession = { twAuth };
  await saveTeamworkSession(session);
  lifecycle.notice("[Teamwork] Authenticated.");
  return session;
}

const loginFlight = singleFlight<TeamworkSession>();

/** Log in (single-flight: concurrent callers share one request). */
async function teamworkLogin(): Promise<TeamworkSession> {
  return loginFlight("teamwork", doLogin);
}

/** The cached tw-auth cookie, or a fresh login. */
export async function ensureTeamworkAuth(): Promise<string> {
  const cached = await loadTeamworkSession();
  if (cached?.twAuth) return cached.twAuth;
  return (await teamworkLogin()).twAuth;
}

/**
 * Replace a rejected session. If a concurrent caller already refreshed it
 * (stored cookie differs from `stale`), reuse theirs.
 */
export async function refreshTeamworkAuth(stale: string): Promise<string> {
  const current = await loadTeamworkSession();
  if (current?.twAuth && current.twAuth !== stale) return current.twAuth;
  return (await teamworkLogin()).twAuth;
}
