// The ONE V1 `/chain/test` payload builder.
//
// `ad test` and `ad run-suites` both post `{category, jsonDefinition, id,
// uuid, version}` (as the AD UI does) with the inputs' `testValue`s set and
// every step carrying an `automationApiId` — the Java compiler needs it, and
// lean (V2-created) chains lack it, which the server answers with 400
// "Invalid Automation API Id" (chain-write-api.md). Posting the whole GET body
// (changelogs, permissions, …) is what made `run-suites` fail with 400.

import { CliError, readErrorBody } from "@belzabar/core";
import { ServiceHydrator } from "./hydrator";
import type { V1AutomationDefinition, V1RawMethodResponse } from "./types/v1-wire";

interface V1TestPayload {
  category: V1RawMethodResponse["category"];
  jsonDefinition: string;
  id: V1RawMethodResponse["id"];
  uuid: string;
  version: V1RawMethodResponse["version"];
}

interface BuildTestPayloadDeps {
  /** Service definition by step `automationId` (default: env-scoped definition cache). */
  getDefinition: (automationId: string) => Promise<V1AutomationDefinition | null>;
}

const defaultDeps: BuildTestPayloadDeps = {
  getDefinition: (id) => ServiceHydrator.getDefinition(id),
};

/** A step's `automationId` as a string: the wire carries a NUMBER; "" when absent. */
export function stepAutomationId(step: Record<string, unknown>): string {
  const v = step.automationId;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") return v.trim();
  return "";
}

/**
 * Build the `/chain/test` body for a freshly fetched V1 method: set
 * `testValue` on the inputs named in `inputs`, and fill `automationApiId` on
 * any step that lacks it from its service definition.
 */
export async function buildV1TestPayload(
  rawMethod: V1RawMethodResponse,
  inputs: Record<string, unknown>,
  deps: BuildTestPayloadDeps = defaultDeps,
): Promise<V1TestPayload> {
  let innerDef: Record<string, unknown>;
  try {
    innerDef = JSON.parse(rawMethod.jsonDefinition) as Record<string, unknown>;
  } catch {
    throw new CliError("Failed to parse method jsonDefinition.", { code: "INVALID_DEFINITION" });
  }

  if (Array.isArray(innerDef.inputs)) {
    innerDef.inputs = (innerDef.inputs as Array<Record<string, unknown>>).map((inp) => {
      const fieldCode = typeof inp.fieldCode === "string" ? inp.fieldCode : null;
      if (fieldCode && Object.prototype.hasOwnProperty.call(inputs, fieldCode)) {
        return { ...inp, testValue: inputs[fieldCode] };
      }
      return inp;
    });
  }

  if (Array.isArray(innerDef.services)) {
    innerDef.services = await Promise.all(
      (innerDef.services as Array<Record<string, unknown>>).map(async (svc) => {
        if (svc.automationApiId != null && svc.automationApiId !== "") return svc;
        const aid = stepAutomationId(svc);
        if (!aid) return svc;
        const def = await deps.getDefinition(aid).catch(() => null);
        const apiId = def?.automationAPI?.id;
        return apiId != null ? { ...svc, automationApiId: apiId } : svc;
      }),
    );
  }

  return {
    category: rawMethod.category,
    jsonDefinition: JSON.stringify(innerDef),
    id: rawMethod.id,
    uuid: rawMethod.uuid,
    version: rawMethod.version,
  };
}

/** The multipart body `/chain/test` expects: one `body` field with the JSON payload. */
export function v1TestFormData(payload: V1TestPayload): FormData {
  const form = new FormData();
  form.append("body", JSON.stringify(payload));
  return form;
}

/**
 * The server's reason for a failed `/chain/test` (status + message), so
 * callers never report a bare "API Request Failed: 400".
 */
export async function describeTestFailure(response: Response): Promise<{ message: string; body: unknown }> {
  const body = await readErrorBody(response);
  let reason = "";
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    const pick = b.message ?? b.errorMessage ?? b.error ?? b.detail;
    if (typeof pick === "string") reason = pick;
    else if (pick != null) reason = JSON.stringify(pick);
  } else if (typeof body === "string") {
    reason = body;
  }
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  return { message: reason ? `${status}: ${reason.slice(0, 500)}` : status, body };
}
