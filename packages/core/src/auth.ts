import { join } from "path";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { Config } from "./config";
import type { AuthSession } from "./types";

const SESSION_DIR = join(homedir(), ".belzabar-cli", "sessions");

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
      "User-Agent": "Bun/1.0 (Belzabar CLI)",
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

  try {
    const jsonBody = JSON.parse(bodyText);
    if (jsonBody.token) {
      token = jsonBody.token;
    }
  } catch (e) {}

  if (!token && bodyText.split('.').length === 3) {
      token = bodyText;
  }

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
