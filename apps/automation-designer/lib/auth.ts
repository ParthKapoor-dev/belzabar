import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { Config } from "./config";

export interface AuthSession {
  token: string;
  refreshToken: string;
}

const SESSION_DIR = join(homedir(), ".ad-cli", "sessions");

function ensureSessionDir() {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
  } catch (e) {
    // Ignore if exists
  }
}

function getSessionFilePath(envName: string) {
  return join(SESSION_DIR, `${envName}.json`);
}

export async function saveSession(session: AuthSession) {
  ensureSessionDir();
  const file = getSessionFilePath(Config.activeEnv.name);
  await Bun.write(file, JSON.stringify(session));
}

export async function loadSession(): Promise<AuthSession | null> {
  try {
    const file = Bun.file(getSessionFilePath(Config.activeEnv.name));
    if (await file.exists()) {
      return await file.json();
    }
  } catch (e) {
    // Ignore errors
  }
  return null;
}

export async function login(): Promise<AuthSession> {
  // Use Config.activeEnv implicitly via Config getters or direct access
  const url = `${Config.cleanBaseUrl}/do/login`;
  const envName = Config.activeEnv.name;
  
  if (!Config.loginId || !Config.password) {
     throw new Error(`Missing credentials for environment '${envName}'. Check your .env file.`);
  }

  console.warn(`[Auth] 🔄 Authenticating to ${envName} (${url})...`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Bun/1.0 (Automation CLI)",
    },
    body: JSON.stringify({
      loginId: Config.loginId,
      password: Config.password,
    }),
  });

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Login failed for ${envName} (${response.status}): ${bodyText}`);
  }

  let token = "";
  let refreshToken = response.headers.get("refresh-token") || "";

  // 1. Try to parse Body as JSON to find "token" field
  try {
    const jsonBody = JSON.parse(bodyText);
    if (jsonBody.token) {
      token = jsonBody.token;
    }
  } catch (e) {
    // Body wasn't JSON, ignore
  }

  // 2. If body didn't have token, check if Body itself is the token
  if (!token && bodyText.split('.').length === 3) {
      token = bodyText;
  }

  // 3. If still no token, Check Headers
  if (!token) {
    const authHeader = response.headers.get("Authorization") || response.headers.get("authorization");
    if (authHeader) {
      if (authHeader.startsWith("Bearer ")) {
        token = authHeader.split(" ")[1];
      } else {
        token = authHeader;
      }
    }
  }

  if (!token) {
    throw new Error("Failed to find token in response body or headers");
  }

  const session: AuthSession = { token, refreshToken };
  await saveSession(session);
  return session;
}