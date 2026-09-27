// V2 write verbs used by `ad save`, `ad create`, `ad delete` and `ad publish`
// (compiled-cache eviction). Reads go through lib/api (adApi / v2.fetchRawMethod).
//
//   POST   /rest/api/automation/chain/v2          create (no uuid) / update (live body)
//   DELETE /rest/api/automation/chain/v2/{uuid}   soft delete (204; V1 GET then shows active:false)
//
// Error bodies are summarised and redacted by core `readErrorBody`.

import { apiFetch, CliError, readErrorBody } from "@belzabar/core";
import type { V2MethodResponse } from "../types/v2-wire";

export const CHAIN_V2_PATH = "/rest/api/automation/chain/v2";

/** Server `errorMessage` from a (redacted) error body, if any. */
function serverMessage(body: unknown): string | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const m = (body as Record<string, unknown>).errorMessage ?? (body as Record<string, unknown>).message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return typeof body === "string" && body.trim() ? body.trim().slice(0, 300) : null;
}

/**
 * POST a V2 method body. With `uuid` it updates that draft, without it creates.
 * Non-2xx → AD_SAVE_REJECTED carrying the server's message.
 */
export async function postChainV2(body: V2MethodResponse | Record<string, unknown>): Promise<V2MethodResponse> {
  const response = await apiFetch(CHAIN_V2_PATH, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const details = await readErrorBody(response);
    const msg = serverMessage(details);
    throw new CliError(`Server rejected the V2 save (${response.status})${msg ? `: ${msg}` : ""}`, {
      code: "AD_SAVE_REJECTED",
      details: { path: CHAIN_V2_PATH, status: response.status, body: details },
    });
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as V2MethodResponse;
  } catch {
    throw new CliError(`V2 save answered ${response.status} without a JSON body.`, {
      code: "AD_SAVE_INVALID_RESPONSE",
      details: { path: CHAIN_V2_PATH, status: response.status },
    });
  }
}

/** Soft-delete a method (`DELETE /chain/v2/{uuid}`). */
export async function deleteChainV2(uuid: string): Promise<number> {
  const path = `${CHAIN_V2_PATH}/${uuid}`;
  const response = await apiFetch(path, { method: "DELETE", authMode: "Bearer" });
  if (!response.ok) {
    const details = await readErrorBody(response);
    const msg = serverMessage(details);
    throw new CliError(`Delete failed (${response.status})${msg ? `: ${msg}` : ""}`, {
      code: "AD_API_ERROR",
      details: { path, status: response.status, body: details },
    });
  }
  return response.status;
}
