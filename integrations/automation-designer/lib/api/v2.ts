// V2 Automation Designer HTTP client.
//
// Only the two verbs where V2 genuinely differs from V1 are implemented:
//   - fetchMethod — parses flat V2 JSON via parseV2Method
//   - testExecute — hits /test/execute/{uuid} with -F form fields and parses
//                   the XML HashMap response
//
// Everything else is V1-only and will not be called with version="v2"
// because SUPPORTED_VERSIONS[op] gates it. If a new V2 verb is added, wire it
// here and update api-version.ts to advertise it.

import { apiFetch, CliError, expectJson, readErrorBody, redactString } from "@belzabar/core";
import { parseV2Method } from "../parser/v2";
import { parseHashMapXml, type ParsedXmlNode } from "../xml";
import type { HydratedMethod } from "../types/common";
import type { V2MethodResponse } from "../types/v2-wire";

async function checkResponse(response: Response, path: string): Promise<void> {
  if (response.ok) return;
  // Small JSON stays structured; anything else is summarised (HTML → title). Redacted.
  const details = await readErrorBody(response);
  throw new CliError(`${response.status} ${response.statusText} on ${path}`, {
    code: "AD_API_ERROR",
    details: { path, status: response.status, body: details },
  });
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

export async function fetchMethod(uuid: string): Promise<HydratedMethod> {
  const path = `/rest/api/automation/chain/v2/${uuid}?basicInfo=false`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  const raw = await fetchChainJson<V2MethodResponse>(response, path, uuid);
  return parseV2Method(raw);
}

export async function fetchRawMethod(uuid: string): Promise<V2MethodResponse> {
  const path = `/rest/api/automation/chain/v2/${uuid}?basicInfo=false`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return fetchChainJson<V2MethodResponse>(response, path, uuid);
}

export interface V2TestExecuteResult {
  /** Whether the server returned executionStatus/failed=false. */
  success: boolean;
  /** Parsed XML HashMap — flat object. */
  outputs: ParsedXmlNode;
  /** Raw XML string as returned by the server. */
  rawXml: string;
}

/**
 * V2 test execute path. Requires the method to already be saved by UUID.
 * Inputs are sent as individual multipart form fields (`-F key=value` in
 * curl). The response is XML HashMap shape per v2-api.md §"V2 Test Execution".
 */
export async function testExecute(
  chainUuid: string,
  inputs: Record<string, string>,
): Promise<V2TestExecuteResult> {
  const path = `/rest/api/automation/chain/test/execute/${chainUuid}`;

  const formData = new FormData();
  let count = 0;
  for (const [key, value] of Object.entries(inputs)) {
    formData.append(key, value);
    count++;
  }
  // Per v2-api.md: "For methods with no required inputs, use -F _dummy=1".
  if (count === 0) formData.append("_dummy", "1");

  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { Accept: "application/xml, text/xml, */*" },
    body: formData,
  });
  await checkResponse(response, path);

  // Debug mode echoes the request headers (bearer token) — scrub before parse/return.
  const rawXml = redactString(await response.text());
  const parsed = parseHashMapXml(rawXml);
  const execStatus = parsed.executionStatus as Record<string, unknown> | undefined;
  const failed = execStatus?.failed === "true" || execStatus?.failed === true;
  return { success: !failed, outputs: parsed, rawXml };
}
