import { join } from "path";
import { mkdirSync } from "fs";
import { BELZ_CONFIG_DIR, loadConfigFileRaw } from "@belzabar/core";
import type { TeamworkSession } from "./types";

const TEAMWORK_BASE = "https://projects.webintensive.com";
const SESSION_DIR = join(BELZ_CONFIG_DIR, "sessions");
const SESSION_FILE = join(SESSION_DIR, "teamwork.json");

function ensureSessionDir() {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
  } catch {
    // ignore if exists
  }
}

export async function saveTeamworkSession(session: TeamworkSession): Promise<void> {
  ensureSessionDir();
  await Bun.write(SESSION_FILE, JSON.stringify(session));
}

export async function loadTeamworkSession(): Promise<TeamworkSession | null> {
  try {
    const file = Bun.file(SESSION_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // ignore
  }
  return null;
}

function getCredentials(): { email: string; password: string } {
  const config = loadConfigFileRaw();
  const tw = (config as any).teamwork;

  const email = tw?.email ?? process.env.TEAMWORK_EMAIL ?? "";
  const passwordEncoded = tw?.password ?? process.env.TEAMWORK_PASSWORD ?? "";
  const password = passwordEncoded ? atob(passwordEncoded) : "";

  return { email, password };
}

export async function teamworkLogin(): Promise<TeamworkSession> {
  const { email, password } = getCredentials();

  if (!email || !password) {
    throw new Error(
      "Missing Teamwork credentials. Set 'teamwork.email' and 'teamwork.password' (base64) in ~/.belz/config.json, or TEAMWORK_EMAIL / TEAMWORK_PASSWORD env vars."
    );
  }

  process.stderr.write(`[Teamwork] Authenticating as ${email}...\n`);

  const response = await fetch(`${TEAMWORK_BASE}/launchpad/v1/login.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Bun/1.0 (Belzabar CLI)",
    },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Teamwork login failed (${response.status}): ${body}`);
  }

  // Extract tw-auth cookie from set-cookie header
  let twAuth = "";
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    const match = cookie.match(/tw-auth=([^;]+)/);
    if (match) {
      twAuth = match[1]!;
      break;
    }
  }

  // Fallback: try single header
  if (!twAuth) {
    const single = response.headers.get("set-cookie") ?? "";
    const match = single.match(/tw-auth=([^;]+)/);
    if (match) twAuth = match[1]!;
  }

  if (!twAuth) {
    throw new Error("Teamwork login succeeded but no tw-auth cookie found in response.");
  }

  const session: TeamworkSession = { twAuth };
  await saveTeamworkSession(session);
  process.stderr.write(`[Teamwork] Authenticated.\n`);
  return session;
}

export async function ensureTeamworkAuth(): Promise<string> {
  const cached = await loadTeamworkSession();
  if (cached?.twAuth) return cached.twAuth;
  const session = await teamworkLogin();
  return session.twAuth;
}
