// V2 Automation Designer reads: the raw `GET /chain/v2/{uuid}` body.
// `adApi.fetchMethod(uuid, "v2")` parses it; the save / create / delete
// pipeline (lib/save/, the only write route) reads it through
// fetchRawMethod too. Writes live in lib/save/api.ts. Other operations are
// V1-only; SUPPORTED_VERSIONS in api-version.ts gates `--v2`.

import { apiFetch, CliError, currentCacheEnv, ensureApiOk, expectJson } from "@belzabar/core";
import { markMethodGone, unmarkMethodGone } from "../method-finder";
import type { V2MethodResponse } from "../types/v2-wire";

function checkResponse(response: Response, path: string): Promise<void> {
  return ensureApiOk(response, { path, code: "AD_API_ERROR" });
}

/**
 * Parse a chain GET. 404 — and 200 with an empty/`null` body, which is how
 * the server answers an unknown uuid (AD-11 / F10) — are METHOD_NOT_FOUND.
 */
async function fetchChainJson<T>(response: Response, path: string, uuid: string): Promise<T> {
  if (response.ok || response.status === 404) {
    return expectJson<T>(response, {
      path,
      notFoundCode: "METHOD_NOT_FOUND",
      notFoundMessage: `Method not found: ${uuid}`,
      details: { uuid },
    });
  }
  // A soft-deleted method has no automation API: the V2 GET answers 400 with
  // an NPE ("automationAPI" is null) while V1 still returns the record.
  if (response.status === 400) {
    const text = await response.clone().text().catch(() => "");
    if (/automationAPI\\?"? is null/.test(text)) {
      throw new CliError(`Method ${uuid} has no automation API on the server (soft-deleted?).`, {
        code: "METHOD_NOT_FOUND",
        details: { uuid, path, status: 400, reason: "automationAPI is null" },
      });
    }
  }
  await checkResponse(response, path);
  throw new Error("unreachable");
}

export async function fetchRawMethod(uuid: string): Promise<V2MethodResponse> {
  const path = `/rest/api/automation/chain/v2/${uuid}?basicInfo=false`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  try {
    const body = await fetchChainJson<V2MethodResponse>(response, path, uuid);
    await unmarkMethodGone(currentCacheEnv(), uuid);
    return body;
  } catch (err) {
    // Unknown or soft-deleted: drop it from the cached method index (find/callers).
    if (err instanceof CliError && err.code === "METHOD_NOT_FOUND") await markMethodGone(currentCacheEnv(), uuid);
    throw err;
  }
}
