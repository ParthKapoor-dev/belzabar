// L4 — online checks against the target environment (read-only).
//
// Service lookup (`L4-service`): every EXISTING_SERVICE step's callee contract
// comes from GET /rest/api/automation-systems/{serviceName}/automation-apis/{uri}
// (V2 steps carry no numeric automationId, so /automations/{id} does not apply;
// db_service registers its APIs under the uri: data.read → select, …). The
// contract's `automationUserInputs[].produces` are the V2 step input keys
// (case-sensitive); `uuid` is the automationAPIId. Accounts come from
// GET /rest/api/automation-systems/{serviceName}/auth. Both are cached 1 h,
// env-scoped.
//
// Dry-run compile (`L4-compile`, opt-in): the V2 body is converted to a V1
// inline-test payload with every step gated by an always-false entry condition
// (#{'belz' eq 'dry-run'}), loops removed and runAsync off, then POSTed to
// /rest/api/automation/chain/test (debug mode). The server compiles the whole
// chain first (binding/compile errors → "Error while compiling automation")
// and then skips every step. Nothing executes; the response is checked for
// that and a step that did execute is reported.

import { join } from "path";
import { apiFetch, BELZ_CONFIG_DIR, Cache, Config, isObj, str as nonBlank } from "@belzabar/core";
import { testMethodMultipart } from "../api/v1";
import { jsonPath, stepKind, stepRef } from "./schema";
import { arr, str, type FindingInput } from "./types";

export interface OnlineOptions {
  env: string;
  dryRunCompile: boolean;
}

/** An automation API contract (the automation-apis record). */
export interface ApiContract {
  id?: number;
  uuid?: string;
  uri?: string;
  label?: string;
  automationUserInputs?: ContractInput[];
  automationAPIOutputs?: Array<{ id?: number; uuid?: string; consumes?: string }>;
}

export interface ContractInput {
  id?: number;
  uuid?: string;
  label?: string;
  produces?: string;
  automationUserInputs?: ContractInput[];
}

const TTL = 60 * 60 * 1000;
const contractCache = new Cache<{ found: boolean; contract?: ApiContract }>({ dir: join(BELZ_CONFIG_DIR, "cache", "api-contracts"), ttlMs: TTL });
const accountCache = new Cache<Array<string | number>>({ dir: join(BELZ_CONFIG_DIR, "cache", "service-accounts"), ttlMs: TTL });

/** db_service registers its APIs under the uri, not the label. */
const URI_BY_LABEL: Record<string, string> = {
  "data.read": "select",
  "data.add": "insert",
  "data.update": "update",
  "data.delete": "delete",
  "schema.modify": "modify",
  "data.schema.modify": "modify",
};

export const DRY_RUN_GATE = "#{'belz' eq 'dry-run'}";

class LookupError extends Error {}

async function getJson(path: string): Promise<unknown | null> {
  let res: Response;
  try {
    res = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  } catch (e) {
    throw new LookupError(e instanceof Error ? e.message : String(e));
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new LookupError(`GET ${path} → ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return null; // AD answers an unknown API with 200 + empty body
  try {
    return JSON.parse(text);
  } catch {
    throw new LookupError(`GET ${path} answered non-JSON`);
  }
}

export async function fetchContract(service: string, method: string): Promise<ApiContract | null> {
  const key = `${service}__${method}`.replace(/[^\w.-]/g, "_");
  const cached = await contractCache.load(key);
  if (cached) return cached.found ? cached.contract ?? null : null;
  const uris = [method, URI_BY_LABEL[method]].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
  for (const uri of uris) {
    const body = await getJson(`/rest/api/automation-systems/${encodeURIComponent(service)}/automation-apis/${encodeURIComponent(uri)}`);
    if (isObj(body) && (body.uuid || body.id)) {
      const contract = body as ApiContract;
      await contractCache.save(key, { found: true, contract: slimContract(contract) });
      return contract;
    }
  }
  await contractCache.save(key, { found: false });
  return null;
}

function slimContract(c: ApiContract): ApiContract {
  const slimInputs = (inputs: ContractInput[] | undefined): ContractInput[] =>
    (inputs ?? []).map((i) => ({ id: i.id, uuid: i.uuid, label: i.label, produces: i.produces, automationUserInputs: slimInputs(i.automationUserInputs) }));
  return {
    id: c.id,
    uuid: c.uuid,
    uri: c.uri,
    label: c.label,
    automationUserInputs: slimInputs(c.automationUserInputs),
    automationAPIOutputs: (c.automationAPIOutputs ?? []).map((o) => ({ id: o.id, uuid: o.uuid, consumes: o.consumes })),
  };
}

export async function fetchAccountIds(service: string): Promise<Array<string | number>> {
  const key = service.replace(/[^\w.-]/g, "_");
  const cached = await accountCache.load(key);
  if (cached) return cached;
  const body = await getJson(`/rest/api/automation-systems/${encodeURIComponent(service)}/auth`);
  const ids = arr(body).filter(isObj).map((a) => a.id).filter((id): id is string | number => typeof id === "number" || typeof id === "string");
  await accountCache.save(key, ids);
  return ids;
}

const trimLower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : undefined);

function allContractUuids(inputs: ContractInput[] | undefined, out = new Set<string>()): Set<string> {
  for (const i of inputs ?? []) {
    const u = trimLower(i.uuid);
    if (u) out.add(u);
    allContractUuids(i.automationUserInputs, out);
  }
  return out;
}

/** The L4 checks, run on `opts.env`; the caller's env selection is restored afterwards. */
export async function runOnline(body: unknown, opts: OnlineOptions): Promise<{ findings: FindingInput[]; layers: string[] }> {
  if (Config.activeEnv.name === opts.env) return runOnlineHere(body, opts);
  return Config.withEnv(opts.env, () => runOnlineHere(body, opts));
}

async function runOnlineHere(body: unknown, opts: OnlineOptions): Promise<{ findings: FindingInput[]; layers: string[] }> {
  const findings: FindingInput[] = [];
  const layers: string[] = [];
  if (!isObj(body) || !Array.isArray(body.steps)) return { findings, layers };

  const contracts = new Map<number, ApiContract>();
  let checked = 0;
  let total = 0;
  for (const [i, s] of body.steps.entries()) {
    if (!isObj(s) || !isObj(s.properties) || s.properties.type !== "EXISTING_SERVICE") continue;
    total++;
    const ref = stepRef(s, i);
    const svc = nonBlank(s.serviceName);
    const m = nonBlank(s.methodName);
    const at = (...rest: Array<string | number>) => jsonPath(["steps", i, ...rest]);
    if (!svc || !m) continue; // ES1 (L1) / id-only steps: nothing to look up by name
    try {
      const contract = await fetchContract(svc, m);
      const apiId = trimLower(s.automationAPIId);
      if (!contract) {
        findings.push(
          apiId
            ? { rule: "AD-SVC-002", message: `${svc}/${m} does not resolve to an automation API; the server uses automationAPIId instead (a bogus id fails the save with 500).`, path: at("methodName"), step: ref }
            : { rule: "AD-SVC-001", message: `${svc}/${m} does not resolve to an automation API.`, path: at("methodName"), step: ref, fix: "Check the names with `belz ad services --search` / `belz ad child-info`.", evidence: "404 Automation API not found with serviceName - … methodName - …" },
        );
        continue;
      }
      contracts.set(i, contract);
      checked++;
      if (apiId && trimLower(contract.uuid) && apiId !== trimLower(contract.uuid)) {
        findings.push({ rule: "AD-SVC-002", message: `automationAPIId ${apiId} is not ${svc}/${m} (${trimLower(contract.uuid)}); the server uses the id and rewrites the names.`, path: at("automationAPIId"), step: ref, fix: "Make automationAPIId and serviceName/methodName name the same API." });
        continue; // the contract we have is not the one the server will use
      }
      checkInputKeys(s, i, ref, contract, findings);
      const acct = isObj(s.accountConfiguration) ? s.accountConfiguration.id : undefined;
      if (acct !== null && acct !== undefined && acct !== "") {
        const ids = (await fetchAccountIds(svc)).map(String);
        if (!ids.includes(String(acct))) {
          findings.push({ rule: "AD-SVC-005", message: `accountConfiguration.id ${acct} is not an account of ${svc} (known: ${ids.join(", ") || "none"}).`, path: at("accountConfiguration", "id"), step: ref, evidence: "v2_sql_bad_account: 500 on save" });
        }
      }
    } catch (e) {
      if (!(e instanceof LookupError)) throw e;
      findings.push({ rule: "AD-SVC-006", message: `Could not look up ${svc}/${m}: ${e.message}. Its contract was not checked.`, path: at("methodName"), step: ref });
    }
  }
  layers.push(checked === total ? "L4-service" : `L4-service(${checked}/${total})`);

  if (opts.dryRunCompile) {
    findings.push(...(await dryRunCompile(body, contracts)));
    layers.push("L4-compile");
  }
  return { findings, layers };
}

function checkInputKeys(s: Record<string, unknown>, i: number, ref: ReturnType<typeof stepRef>, contract: ApiContract, findings: FindingInput[]): void {
  const uuids = allContractUuids(contract.automationUserInputs);
  const walk = (inputs: unknown, level: ContractInput[] | undefined, base: Array<string | number>) => {
    if (!level || level.length === 0) return;
    arr(inputs).forEach((inp, j) => {
      if (!isObj(inp)) return;
      const key = str(inp.key) ?? "";
      const path = [...base, j];
      const match = level.find((c) => c.produces === key);
      if (match) {
        // Descend into OBJECT inputs only (ARRAY children are element values, not contract fields).
        if (inp.type === "OBJECT" || inp.displayWidgetSuggestion === "OBJECT") walk(inp.properties, match.automationUserInputs, [...path, "properties"]);
        return;
      }
      const known = level.map((c) => c.produces).filter((p): p is string => !!p);
      const ci = known.find((p) => p.toLowerCase() === key.toLowerCase());
      const u = trimLower(inp.uuid);
      if (u && uuids.has(u)) {
        findings.push({ rule: "AD-SVC-004", message: `Input key "${key}" is not in the callee contract${ci ? ` (did you mean "${ci}"?)` : ""}; its uuid matches, so the server repairs the key.`, path: jsonPath([...path, "key"]), step: ref, fix: ci ? `Use "${ci}".` : undefined });
      } else {
        findings.push({ rule: "AD-SVC-003", message: `Input key "${key}" is not in the callee contract (${known.join(", ") || "no inputs"})${ci ? `; keys are case-sensitive, did you mean "${ci}"?` : ""} and no uuid matches: the input is silently dropped.`, path: jsonPath([...path, "key"]), step: ref, fix: ci ? `Use "${ci}".` : "Use a key the service declares (belz ad child-info).", evidence: "v2_step_input_key_unknown_no_uuid: input dropped, output empty" });
      }
    });
  };
  walk(s.inputs, contract.automationUserInputs, ["steps", i, "inputs"]);
}

// ── dry-run compile ───────────────────────────────────────────────────────

/** Build the V1 inline-test payload for a V2 body, every step gated off. */
export function buildDryRunPayload(body: Record<string, unknown>, contracts: Map<number, ApiContract>): Record<string, unknown> {
  const field = (f: unknown) => {
    const o = isObj(f) ? f : {};
    return {
      fieldCode: o.key, label: o.name ?? o.key, type: o.type, required: false, hideInput: false,
      properties: arr(o.properties), description: o.description ?? "", defaultValue: o.defaultValue ?? "",
      testValue: "", encodingType: o.encodingType ?? "NONE",
    };
  };
  const services = arr(body.steps).map((s, i) => {
    const step = isObj(s) ? s : {};
    const props = isObj(step.properties) ? step.properties : {};
    const exit = isObj(props.exitCondition) && isObj(props.exitCondition.exitOnFailure) ? props.exitCondition.exitOnFailure : {};
    const common: Record<string, unknown> = {
      orderIndex: i + 1,
      description: step.description ?? "",
      runAsync: false,
      conditionMode: "advance",
      conditionExpression: DRY_RUN_GATE,
      condition: [],
      forceExitFromFailure: exit.value === true,
      forceExitErrorMessage: exit.message ?? "",
      repeatStepExecution: false,
    };
    if (stepKind(step) === "CUSTOM_CODE") {
      const cc = isObj(props.customCode) ? props.customCode : {};
      return {
        ...common,
        activeTab: { id: "customCode" },
        code: cc.inlineCode ?? "",
        language: cc.language,
        customCodeEnv: cc.executor ?? "CODE_LAMBDA",
        mappings: [],
        outputs: arr(step.outputs).filter(isObj).map((o) => ({ code: o.key, displayName: o.name ?? o.key, type: o.type ?? "TEXT", elementToRetrieve: o.elementToRetrieve ?? undefined, properties: [], rawResponseContainer: false })),
      };
    }
    const contract = contracts.get(i);
    const inputByUuid = new Map<string, ContractInput>();
    const index = (inputs: ContractInput[] | undefined) => {
      for (const c of inputs ?? []) {
        const u = trimLower(c.uuid);
        if (u) inputByUuid.set(u, c);
        index(c.automationUserInputs);
      }
    };
    index(contract?.automationUserInputs);
    const mapping = (inp: Record<string, unknown>, level: ContractInput[] | undefined): Record<string, unknown> => {
      const c = inputByUuid.get(trimLower(inp.uuid) ?? "") ?? level?.find((x) => x.produces === inp.key);
      return {
        value: inp.value ?? undefined,
        combineInputs: inp.combineInput === true,
        encodingType: inp.encodingType ?? "NONE",
        encodedBase64: inp.encodedBase64 === true,
        uiRepresentation: inp.displayWidgetSuggestion ?? "CUSTOM",
        automationUserInputId: c?.id,
        automationUserInputUuid: inp.uuid ?? c?.uuid,
        mappings: arr(inp.properties).filter(isObj).map((p) => mapping(p, c?.automationUserInputs)),
      };
    };
    const outputs = contract?.automationAPIOutputs ?? [];
    const acct = isObj(step.accountConfiguration) ? step.accountConfiguration : undefined;
    return {
      ...common,
      activeTab: { id: "existingService" },
      automationApiId: contract?.id,
      automationApiUuid: step.automationAPIId ?? contract?.uuid,
      categoryName: step.serviceName,
      ...(acct?.id != null ? { automationAuthId: acct.id, testAccountId: acct.id, accountName: acct.name } : {}),
      mappings: arr(step.inputs).filter(isObj).map((inp) => mapping(inp, contract?.automationUserInputs)),
      outputs: arr(step.outputs).filter(isObj).map((o) => {
        const co = outputs.find((x) => x.consumes === o.key) ?? outputs.find((x) => trimLower(x.uuid) === trimLower(o.uuid));
        const ir = isObj(o.inputReference) ? nonBlank(o.inputReference.reference) : undefined;
        return {
          code: o.fieldCode, fieldCode: o.fieldCode, displayName: o.name ?? o.fieldCode, outputCode: o.key,
          automationAPIOutputId: co?.id, automationAPIOutputUuid: o.uuid ?? co?.uuid,
          ...(ir ? { internalVarRef: ir } : {}), properties: [], rawResponseContainer: false, hiddenAutomationAPIOutputIds: [],
        };
      }),
    };
  });
  const inner = {
    name: body.name,
    inputs: arr(body.inputs).map(field),
    variables: arr(body.variables).map(field),
    outputs: arr(body.outputs).filter(isObj).map((o) => ({ code: o.key, fieldCode: o.key, outputCode: o.key, displayName: o.name ?? o.key, type: o.type, properties: [], rawResponseContainer: false, hiddenAutomationAPIOutputIds: [] })),
    services,
  };
  const meta = isObj(body.metadata) ? body.metadata : {};
  const service = isObj(meta.service) ? meta.service : {};
  return {
    jsonDefinition: JSON.stringify(inner),
    category: { id: service.id, name: service.name },
    methodDeprecated: false,
    ...(nonBlank(body.uuid) ? { uuid: nonBlank(body.uuid) } : {}),
  };
}

async function dryRunCompile(body: Record<string, unknown>, contracts: Map<number, ApiContract>): Promise<FindingInput[]> {
  const payload = buildDryRunPayload(body, contracts);
  const fd = new FormData();
  fd.append("body", JSON.stringify(payload));
  let res: Response;
  try {
    res = await testMethodMultipart(fd);
  } catch (e) {
    return [{ rule: "AD-SVC-006", message: `Dry-run compile request failed: ${e instanceof Error ? e.message : String(e)}.`, path: "" }];
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  const msg = isObj(json) ? str(json.errorMessage) ?? str(json.message) : undefined;
  if (!res.ok) {
    if (msg && /compil/i.test(msg)) {
      return [{ rule: "AD-COMPILE-001", message: `The server could not compile the method: ${msg}.`, path: "", fix: "Check bound services, input uuids and account ids (belz ad validate --online).", evidence: `${res.status} ${msg}` }];
    }
    // ADW-R11: any other non-2xx (500 "automationAPI is null" for a bogus apiId, a bad account,
    // 400 "Invalid state", …) is the server refusing this body — blocking, not a lookup warning.
    return [{ rule: "AD-COMPILE-002", message: `Dry-run compile was refused with ${res.status}${msg ? `: ${msg}` : ""}; the save would fail or the method would not run.`, path: "", fix: "Check bound services (automationAPIId), accounts and input uuids (belz ad validate --online).", evidence: `${res.status}${msg ? ` ${msg}` : ""}` }];
  }
  const ran = dryRunExecutedSteps(json);
  return ran.map((orderIndex) => ({
    rule: "AD-COMPILE-001",
    severity: "warn" as const,
    message: `Dry run: step ${orderIndex} executed despite the false entry gate; do not rely on --dry-run-compile for this method.`,
    path: jsonPath(["steps", orderIndex - 1]),
  }));
}

/** orderIndexes of steps the debug trace reports as executed. */
export function dryRunExecutedSteps(json: unknown): number[] {
  const services = isObj(json) && isObj(json.debugResult) ? arr(json.debugResult.services) : isObj(json) ? arr(json.services) : [];
  const ran: number[] = [];
  for (const s of services) {
    if (!isObj(s) || !isObj(s.executionStatus)) continue;
    if (s.executionStatus.executed === true) ran.push(typeof s.orderIndex === "number" ? s.orderIndex : ran.length + 1);
  }
  return ran;
}

