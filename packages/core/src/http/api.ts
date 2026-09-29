// apiFetch — the Expertly (AD/PD) client. Public API unchanged: resolves with
// the Response (callers map non-OK with errors.ts httpError/expectJson).
//
// On top of the transport (timeout, IPv4 pin + eviction, coded network errors):
//   - Bearer/Raw auth from the env's session, single-flight login;
//   - 401 → one refresh (shared across concurrent callers) + one retry,
//     including FormData bodies; non-replayable bodies (streams) are not retried;
//     a second 401 after a successful re-login is AUTH_FAILED (never a loop);
//   - no Content-Type on GET/HEAD or FormData (CORE-19).

import { Config } from "../config";
import { CliError } from "../command";
import type { ApiOptions } from "../types";
import { lifecycle } from "../ui";
import { readBodySummary } from "./errors";
import { redactString } from "./redact";
import { ensureSession, refreshSession } from "./auth";
import { httpRequest, isReplayableBody } from "./transport";

export async function apiFetch(path: string, options: ApiOptions = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${Config.cleanBaseUrl}${path}`;
  const { authMode = "Bearer", timeoutMs, headers: rawHeaders, ...init } = options;
  const method = (init.method ?? "GET").toUpperCase();

  const headers = new Headers(rawHeaders || {});
  // "Expertly-Auth-Token: true" is a request to send the session token in that header.
  const wantsExpertlyToken = headers.get("Expertly-Auth-Token") === "true";
  if (wantsExpertlyToken) headers.delete("Expertly-Auth-Token");

  if (!headers.has("Accept")) headers.set("Accept", "application/json, text/plain, */*");
  if (!headers.has("User-Agent")) headers.set("User-Agent", "Bun/1.0 (Belzabar CLI)");
  if (!headers.has("Content-Type") && method !== "GET" && method !== "HEAD" && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const applyToken = (token: string) => {
    if (authMode === "Bearer") headers.set("Authorization", `Bearer ${token}`);
    else if (authMode === "Raw") headers.set("Authorization", token);
    if (wantsExpertlyToken) headers.set("Expertly-Auth-Token", token);
  };

  let token: string | null = null;
  if (authMode !== "None") {
    token = (await ensureSession()).token;
    applyToken(token);
  }

  const send = () => httpRequest(url, { ...init, method, headers, timeoutMs });
  let response = await send();

  if (response.status === 401 && authMode !== "None") {
    if (!isReplayableBody(init.body)) {
      throw new CliError(`401 Unauthorized on ${method} ${redactString(path)} (request body cannot be replayed after re-login).`, {
        code: "AUTH_EXPIRED",
      });
    }
    lifecycle.notice("401 Unauthorized — refreshing session…");
    // Drain the rejected body so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    const fresh = await refreshSession(token);
    applyToken(fresh.token);
    response = await send();
    if (response.status === 401) {
      const body = await readBodySummary(response);
      const where = `${method} ${redactString(path)}`;
      throw new CliError(
        `401 Unauthorized on ${where} even after re-login: the account may lack access to this resource.`,
        { code: "AUTH_FAILED", details: { status: 401, path: redactString(path), body, reloggedIn: true } },
      );
    }
  }

  return response;
}
