import { Config } from "./config";
import { login, loadSession } from "./auth";

interface ApiOptions extends RequestInit {
  authMode?: "Bearer" | "Raw" | "None";
}

export async function apiFetch(path: string, options: ApiOptions = {}) {
  const url = path.startsWith("http") ? path : `${Config.cleanBaseUrl}${path}`;
  
  // Helper to attach auth headers
  const attachAuth = async (headers: Headers, forceRefresh = false) => {
    if (options.authMode === "None") return;

    let session = await loadSession();
    if (!session || forceRefresh) {
      session = await login();
    }

    if (options.authMode === "Bearer") {
      headers.set("Authorization", `Bearer ${session.token}`);
    } else if (options.authMode === "Raw") {
      headers.set("Authorization", session.token);
    }
  };

  const headers = new Headers(options.headers || {});
  
  // Default headers
  if (!headers.has("Accept")) headers.set("Accept", "application/json, text/plain, */*");
  if (!headers.has("User-Agent")) headers.set("User-Agent", "Bun/1.0 (Automation CLI)");
  if (!headers.has("Content-Type") && options.method !== "GET" && options.method !== "HEAD") {
      headers.set("Content-Type", "application/json");
  }

  // Initial Auth
  await attachAuth(headers);

  let response = await fetch(url, { ...options, headers });

  // Retry on 401
  if (response.status === 401 && options.authMode !== "None") {
    console.warn("⚠️  401 Unauthorized. Refreshing session...");
    await attachAuth(headers, true); // Force login and update header
    response = await fetch(url, { ...options, headers });
  }

  return response;
}

export async function fetchAutomationDefinition(automationId: string) {
  const path = `/rest/api/automations/${automationId}?basicinfo=false`;
  return apiFetch(path, {
    method: "GET",
    authMode: "Bearer"
  });
}
