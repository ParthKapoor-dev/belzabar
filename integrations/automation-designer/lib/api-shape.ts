// `ad child-info --shape`: the part of an automation-API contract
// an agent needs to wire a step — V2 step input keys (`produces`, case-
// sensitive, nested with dots), types, required flags, encodings, enum values,
// defaults; output keys (`consumes`); and, for services that need an account,
// the auth accounts as `id nickname (scope)` — never field values.
//
// The contract is GET /rest/api/automation-systems/{service}/automation-apis/{method}
// (what `ad child-info` fetches); accounts are GET /automation-systems/{service}/auth.

import { apiFetch, isObj, str, type Obj } from "@belzabar/core";
import { normalizeUuid } from "@belzabar/core/platform";


export interface ApiShape {
  service: string;
  method: string;
  /** automationAPIId a V2 step uses (trimmed). */
  apiUuid?: string;
  /** Numeric automation-API id (env-local; what V1 steps' `automationApiId` holds). */
  apiId?: number;
  /** Published chain uuid when the API is a user/helper method. */
  methodUuid?: string;
  alias?: string;
  state?: string;
  accountRequired?: boolean;
  streamCapable?: boolean;
  deprecated?: boolean;
  /** One line per input: `path TYPE [required] [BASE_64] [enum a|b] [default=x] (label)`. */
  inputs: string[];
  /** Inputs hidden in the UI (showOnUi:false), omitted unless `all`. */
  hiddenInputs?: number;
  /** One line per output: `key TYPE (displayName)`. */
  outputs: string[];
  /** `id nickname (scope)` — only when the service has accounts / needs one. */
  accounts?: string[];
}

function enumOf(input: Obj): string[] | undefined {
  if (input.uiRepresentation === "CUSTOM") return undefined; // the "This exactly / Step response" input-mode picker, not values
  for (const src of Array.isArray(input.automationUserInputSources) ? input.automationUserInputSources : []) {
    if (!isObj(src) || typeof src.data !== "string") continue;
    try {
      const data = JSON.parse(src.data) as unknown;
      if (!Array.isArray(data)) continue;
      const vals = data.map((d) => (isObj(d) ? d[str(src.valueParam) ?? "id"] ?? d.id : d)).filter((v) => v !== undefined && v !== null);
      if (vals.length) return vals.map(String);
    } catch {
      /* not JSON — no enum */
    }
  }
  return undefined;
}

function inputLine(path: string, i: Obj): string {
  const bits = [path, str(i.dataType) ?? "?"];
  if (i.optional === false) bits.push("required");
  if (i.encodingType === "BASE_64" || i.encodedBase64 === true) bits.push("BASE_64");
  if (i.sensitive === true) bits.push("sensitive");
  const en = enumOf(i);
  if (en) bits.push(`enum ${en.join("|")}`);
  const def = typeof i.defaultUserInputvalue === "string" && i.defaultUserInputvalue !== "" ? i.defaultUserInputvalue : undefined;
  if (def !== undefined) bits.push(`default=${def.length > 60 ? `${def.slice(0, 60)}…` : def}`);
  const label = str(i.label);
  const leaf = path.split(".").pop();
  if (label && label !== leaf) bits.push(`(${label})`);
  return bits.join(" ");
}

export function apiShape(contract: unknown, service: string, method: string, opts: { all?: boolean } = {}): ApiShape {
  const c = isObj(contract) ? contract : {};
  const inputs: string[] = [];
  let hidden = 0;
  const walk = (list: unknown, prefix: string) => {
    for (const raw of Array.isArray(list) ? list : []) {
      if (!isObj(raw)) continue;
      const produces = str(raw.produces) ?? str(raw.label) ?? "?";
      // Some contracts already carry the full dotted path (`array.aElement`).
      const path = prefix && !produces.startsWith(`${prefix}.`) ? `${prefix}.${produces}` : produces;
      const visible = raw.showOnUi !== false && raw.hideInput !== true;
      if (!visible && !opts.all) {
        hidden++;
        continue;
      }
      inputs.push(inputLine(path, raw));
      walk(raw.automationUserInputs, path);
    }
  };
  walk(c.automationUserInputs, "");

  const outputs = (Array.isArray(c.automationAPIOutputs) ? c.automationAPIOutputs : [])
    .filter(isObj)
    .filter((o) => opts.all || (o.showOnUi !== false && o.active !== false))
    .map((o) => {
      const key = str(o.consumes) ?? "?";
      const name = str(o.displayName);
      return `${key} ${str(o.dataType) ?? "?"}${name && name !== key ? ` (${name})` : ""}`;
    });

  const shape: ApiShape = {
    service,
    method,
    apiUuid: normalizeUuid(c.uuid) ?? undefined,
    apiId: typeof c.id === "number" ? c.id : undefined,
    methodUuid: normalizeUuid(c.methodUUID ?? c.serviceChainUID) ?? undefined,
    alias: str(c.aliasName) !== method ? str(c.aliasName) : undefined,
    state: str(c.automationState) ?? str(c.state),
    accountRequired: c.accountRequired === true || undefined,
    streamCapable: c.streamCapable === true || undefined,
    deprecated: c.methodDeprecated === true || undefined,
    inputs,
    outputs,
  };
  if (hidden) shape.hiddenInputs = hidden;
  return shape;
}

/** `id nickname (scope)` per account of the service. Field values are never read. */
export function accountLines(body: unknown): string[] {
  return (Array.isArray(body) ? body : [])
    .filter(isObj)
    .filter((a) => a.id !== undefined && a.id !== null)
    .map((a) => {
      const scope = str(a.authUsageType);
      return `${String(a.id)} ${str(a.nickname) ?? "(no nickname)"}${scope ? ` (${scope})` : ""}`;
    });
}

/** GET /automation-systems/{service}/auth → account lines; [] when none / not found. */
export async function fetchAccountLines(service: string): Promise<string[]> {
  const res = await apiFetch(`/rest/api/automation-systems/${encodeURIComponent(service)}/auth`, { method: "GET", authMode: "Bearer" });
  if (!res.ok) return [];
  const text = await res.text();
  if (!text.trim()) return [];
  try {
    return accountLines(JSON.parse(text));
  } catch {
    return [];
  }
}
