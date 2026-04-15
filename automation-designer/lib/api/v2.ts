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

import { apiFetch, CliError } from "@belzabar/core";
import { parseV2Method } from "../parser/v2";
import { parseHashMapXml, type ParsedXmlNode } from "../xml";
import type { HydratedMethod } from "../types/common";
import type { V2MethodResponse } from "../types/v2-wire";

async function checkResponse(response: Response, path: string): Promise<void> {
  if (response.ok) return;
  let details: unknown;
  try {
    const text = await response.text();
    try {
      details = JSON.parse(text);
    } catch {
      details = text.slice(0, 1024);
    }
  } catch {
    details = "(response body unreadable)";
  }
  throw new CliError(`${response.status} ${response.statusText} on ${path}`, {
    code: "AD_API_ERROR",
    details: { path, status: response.status, body: details },
  });
}

export async function fetchMethod(uuid: string): Promise<HydratedMethod> {
  const path = `/rest/api/automation/chain/v2/${uuid}?basicInfo=false`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  if (response.status === 404) {
    throw new CliError("404 Chain Not Found", { code: "METHOD_NOT_FOUND", details: { path } });
  }
  await checkResponse(response, path);
  const raw = (await response.json()) as V2MethodResponse;
  return parseV2Method(raw);
}

export async function fetchRawMethod(uuid: string): Promise<V2MethodResponse> {
  const path = `/rest/api/automation/chain/v2/${uuid}?basicInfo=false`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  if (response.status === 404) {
    throw new CliError("404 Chain Not Found", { code: "METHOD_NOT_FOUND", details: { path } });
  }
  await checkResponse(response, path);
  return (await response.json()) as V2MethodResponse;
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

  const rawXml = await response.text();
  const parsed = parseHashMapXml(rawXml);
  const execStatus = parsed.executionStatus as Record<string, unknown> | undefined;
  const failed = execStatus?.failed === "true" || execStatus?.failed === true;
  return { success: !failed, outputs: parsed, rawXml };
}
