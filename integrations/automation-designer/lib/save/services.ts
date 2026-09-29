// Callee contracts + db accounts for the compact expander (lib/serialize/compact).
// Read-only lookups on the target env, cached like the validator's L4:
//   GET /rest/api/automation-systems/{svc}/automation-apis/{uri}   (lib/validate/online fetchContract)
//   GET /rest/api/automation-systems/{svc}/auth                    (db_service accounts: id + nickname)

import { apiFetch, CliError, readJsonOrNull } from "@belzabar/core";
import { fetchContract } from "../validate/online";
import { compactService, emptyCatalog, isObj, splitService, type DbAccount, type ServiceCatalog } from "../serialize/compact";
import { stepService } from "../serialize/ops";
import type { V2MethodResponse, V2Step } from "../types/v2-wire";

/** `"svc/method"` names a list of compact steps calls. */
export function servicesOfCompactSteps(steps: unknown[]): string[] {
  const out: string[] = [];
  for (const s of steps) if (isObj(s)) {
    const svc = compactService(s);
    if (svc) out.push(svc);
  }
  return out;
}

/** Services the structural ops need: new steps' callees, and updated steps whose inputs/sql/account/outputs change. */
export function servicesOfOps(live: V2MethodResponse, ops: unknown): string[] {
  if (!Array.isArray(ops)) return [];
  const steps: V2Step[] = Array.isArray(live.steps) ? live.steps : [];
  const out: string[] = [];
  for (const op of ops) {
    if (!isObj(op)) continue;
    if (op.op === "add-step" && isObj(op.step)) out.push(...servicesOfCompactSteps([op.step]));
    if (op.op === "update-step" && typeof op.step === "number" && isObj(op.set)) {
      const s = steps[op.step - 1];
      const svc = s ? stepService(s) : null;
      if (svc && ["inputs", "sql", "account", "outputs"].some((k) => k in (op.set as object))) out.push(svc);
    }
  }
  return out;
}

async function fetchAccounts(service: string): Promise<DbAccount[]> {
  const path = `/rest/api/automation-systems/${encodeURIComponent(service)}/auth`;
  const res = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  if (!res.ok) {
    throw new CliError(`Could not list the accounts of ${service} (${res.status}).`, { code: "AD_API_ERROR", details: { path, status: res.status } });
  }
  const body: unknown = (await readJsonOrNull<unknown>(res, { path })) ?? [];
  return (Array.isArray(body) ? body : [])
    .filter(isObj)
    .filter((a) => typeof a.id === "number" || typeof a.id === "string")
    .map((a) => ({ id: a.id as number | string, nickname: typeof a.nickname === "string" ? a.nickname : null }));
}

/** Load every contract (and db_service accounts) the names need. Unknown APIs map to null. */
export async function loadServiceCatalog(services: string[]): Promise<ServiceCatalog> {
  const cat = emptyCatalog();
  for (const name of new Set(services)) {
    const sm = splitService(name);
    if (!sm) continue; // expandCompactStep reports the malformed name
    try {
      cat.contracts.set(name, await fetchContract(sm.service, sm.method));
    } catch (e) {
      throw new CliError(`Could not look up ${name}: ${e instanceof Error ? e.message : String(e)}`, { code: "AD_API_ERROR", details: { service: name } });
    }
    if (sm.service === "db_service" && !cat.accounts.has(sm.service)) cat.accounts.set(sm.service, await fetchAccounts(sm.service));
  }
  return cat;
}
