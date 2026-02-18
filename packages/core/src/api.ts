import { Config } from "./config";
import { login, loadSession } from "./auth";
import type { ApiOptions } from "./types";

export async function apiFetch(path: string, options: ApiOptions = {}) {
  const url = path.startsWith("http") ? path : `${Config.cleanBaseUrl}${path}`;
  
  const attachAuth = async (headers: Headers, forceRefresh = false) => {
    if (options.authMode === "None") return;

    let session = await loadSession();
    if (!session || forceRefresh) {
      session = await login();
    }

    if (options.authMode === "Bearer" || !options.authMode) {
      headers.set("Authorization", `Bearer ${session.token}`);
    } else if (options.authMode === "Raw") {
      headers.set("Authorization", session.token);
    }
    
    if (options.headers && (options.headers as any)["Expertly-Auth-Token"] === "true") {
        headers.set("Expertly-Auth-Token", session.token);
    }
  };

  const headers = new Headers(options.headers || {});
  
  if (!headers.has("Accept")) headers.set("Accept", "application/json, text/plain, */*");
  if (!headers.has("User-Agent")) headers.set("User-Agent", "Bun/1.0 (Belzabar CLI)");
  
  if (!headers.has("Content-Type") && options.method !== "GET" && options.method !== "HEAD" && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
  }

  await attachAuth(headers);

  let response = await fetch(url, { ...options, headers });

  if (response.status === 401 && options.authMode !== "None") {
    process.stderr.write("⚠️  401 Unauthorized. Refreshing session...\n");
    await attachAuth(headers, true);
    response = await fetch(url, { ...options, headers });
  }

  return response;
}
