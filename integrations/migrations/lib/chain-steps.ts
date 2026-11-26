// AD method steps as `migrate run` needs them, from the V2 chain body
// (`/chain/v2/<uuid>?basicInfo=false`): each step names its callee
// (serviceName / methodName, automationAPIId) and its inputs as key / value.
//
// Two uses:
//   - pre-flight (H4): batch members that call each other. The service
//     migrates a batch at once and fails a caller whose callee is new on the
//     target ("dependent … not found in destination"), so wi-impl warns and
//     suggests waves (callees first).
//   - after the build (H5): a migrated method's step inputs on the target vs
//     the source. A caller has lost step inputs on the target while the
//     versions said both sides were the same.

import { CliError, Config, isObj, type Obj } from "@belzabar/core";
import { fetchRawEntity } from "@belzabar/core/platform";

const adChainV2Path = (uuid: string): string => `/rest/api/automation/chain/v2/${uuid}?basicInfo=false`;

/** The V2 body of `uuid` on the active env; null when not found. Throws on other errors. */
export async function fetchChainV2(uuid: string): Promise<Obj | null> {
  const got = await fetchRawEntity<unknown>(adChainV2Path(uuid), {
    onError: (res) => new CliError(`HTTP ${res.status} reading the V2 body of ${uuid}`, { code: "MIGRATE_CHAIN_READ_FAILED" }),
  });
  return got.found && isObj(got.body) ? got.body : null;
}

const s = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

interface StepMapping {
  /** 1-based, as `ad show` numbers steps. */
  step: number;
  /** `service.method` for a call step, else the step type (CUSTOM_CODE, …). */
  callee: string;
  service?: string;
  method?: string;
  api?: string;
  /** Input path → value (nested properties as `a.b`); empty values left out. */
  inputs: Record<string, string>;
}

function flattenInputs(inputs: unknown, prefix: string, out: Record<string, string>): void {
  for (const i of Array.isArray(inputs) ? inputs : []) {
    if (!isObj(i)) continue;
    const key = s(i.key);
    if (!key) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = Array.isArray(i.properties) ? i.properties.filter((p) => isObj(p) && "key" in p) : [];
    if (nested.length > 0) flattenInputs(nested, path, out);
    else if (typeof i.value === "string" ? i.value !== "" : i.value !== undefined && i.value !== null) {
      out[path] = typeof i.value === "string" ? i.value : JSON.stringify(i.value);
    }
  }
}

export function stepMappingsOf(body: Obj): StepMapping[] {
  return (Array.isArray(body.steps) ? body.steps : []).filter(isObj).map((step, idx) => {
    const service = s(step.serviceName);
    const method = s(step.methodName);
    const props = isObj(step.properties) ? step.properties : {};
    const inputs: Record<string, string> = {};
    flattenInputs(step.inputs, "", inputs);
    return {
      step: idx + 1,
      callee: service && method ? `${service}.${method}` : s(props.type) ?? "step",
      service,
      method,
      api: s(step.automationAPIId)?.toLowerCase(),
      inputs,
    };
  });
}

/** A method's identity as a callee: its category + name, and its automation-API uuid. */
function identityOf(body: Obj): { name?: string; category?: string; api?: string } {
  const meta = isObj(body.metadata) ? body.metadata : {};
  const service = isObj(meta.service) ? meta.service : {};
  return { name: s(body.name), category: s(service.name), api: s(body.automationApiId)?.toLowerCase() };
}

export interface BatchCall {
  caller: string;
  callerName?: string;
  step: number;
  callee: string;
  calleeName?: string;
}

/** Steps of batch members that call another member. */
export function batchCalls(bodies: ReadonlyMap<string, Obj>): BatchCall[] {
  const ids = [...bodies.keys()];
  const idents = new Map(ids.map((id) => [id, identityOf(bodies.get(id)!)]));
  const calls: BatchCall[] = [];
  for (const caller of ids) {
    for (const st of stepMappingsOf(bodies.get(caller)!)) {
      for (const callee of ids) {
        if (callee === caller) continue;
        const t = idents.get(callee)!;
        const byApi = !!st.api && st.api === t.api;
        const byName = !!t.name && !!t.category && st.method === t.name && st.service === t.category;
        if (byApi || byName) {
          calls.push({ caller, callerName: idents.get(caller)!.name, step: st.step, callee, calleeName: t.name });
        }
      }
    }
  }
  return calls;
}

/**
 * Migration waves: every id in the first wave it can go in once its callees
 * went before it. Ids in a call cycle share the last wave.
 */
export function migrationWaves(ids: readonly string[], calls: readonly BatchCall[]): string[][] {
  const waves: string[][] = [];
  const placed = new Set<string>();
  let rest = [...ids];
  while (rest.length > 0) {
    const wave = rest.filter((id) => calls.every((c) => c.caller !== id || c.callee === id || placed.has(c.callee)));
    if (wave.length === 0) {
      waves.push(rest);
      break;
    }
    waves.push(wave);
    for (const id of wave) placed.add(id);
    rest = rest.filter((id) => !placed.has(id));
  }
  return waves;
}

/** A method the batch calls that the target does not have (by category/name). */
interface MissingCallee {
  /** `Category/name`, as the service names it. */
  callee: string;
  callers: Array<{ id: string; name?: string; step: number }>;
  /** The batch member that is this callee (it is new on the target). */
  inBatch?: string;
}

export interface CalleeCheck {
  targetEnv: string;
  /** Distinct callees looked up. */
  checked: number;
  missing: MissingCallee[];
  /** Callees that could not be looked up, with why. */
  errors?: Array<{ callee: string; error: string }>;
}

const automationApiPath = (service: string, method: string): string =>
  `/rest/api/automation-systems/${encodeURIComponent(service)}/automation-apis/${encodeURIComponent(method)}`;

/**
 * Pre-flight: every method the batch's steps call must exist on the target by
 * category/name, or the service refuses the whole batch ("dependent method(s)
 * … not found in the destination environment"). One GET per distinct callee
 * on `targetEnv` (unknown → 200 with an empty body); the active env is
 * restored. Throws only when the env switch itself fails.
 */
export async function checkCalleesOnTarget(bodies: ReadonlyMap<string, Obj>, targetEnv: string): Promise<CalleeCheck> {
  const callees = new Map<string, MissingCallee & { service: string; method: string }>();
  for (const [id, body] of bodies) {
    const callerName = s(body.name);
    for (const st of stepMappingsOf(body)) {
      if (!st.service || !st.method) continue;
      const key = `${st.service}/${st.method}`;
      const entry = callees.get(key) ?? { callee: key, service: st.service, method: st.method, callers: [] };
      entry.callers.push({ id, ...(callerName ? { name: callerName } : {}), step: st.step });
      callees.set(key, entry);
    }
  }
  const members = [...bodies].map(([id, body]) => ({ id, ...identityOf(body) }));
  const missing: MissingCallee[] = [];
  const errors: Array<{ callee: string; error: string }> = [];
  const restore = Config.captureActiveEnv();
  try {
    Config.setActiveEnv(targetEnv);
    const all = [...callees.values()];
    // A few lookups at a time: a batch can call dozens of distinct methods.
    for (let i = 0; i < all.length; i += 8) {
      await Promise.all(all.slice(i, i + 8).map(async (c) => {
        try {
          const got = await fetchRawEntity<unknown>(automationApiPath(c.service, c.method), {
            onError: (res) => new CliError(`HTTP ${res.status}`, { code: "MIGRATE_CALLEE_READ_FAILED" }),
          });
          if (got.found && isObj(got.body) && Object.keys(got.body).length > 0) return;
          const member = members.find((m) => m.name === c.method && m.category === c.service);
          missing.push({ callee: c.callee, callers: c.callers, ...(member ? { inBatch: member.id } : {}) });
        } catch (e) {
          errors.push({ callee: c.callee, error: e instanceof Error ? e.message : String(e) });
        }
      }));
    }
  } finally {
    restore();
  }
  const order = (a: { callee: string }, b: { callee: string }) => a.callee.localeCompare(b.callee);
  return { targetEnv, checked: callees.size, missing: missing.sort(order), ...(errors.length ? { errors: errors.sort(order) } : {}) };
}

interface StepDifference {
  step: number;
  callee: string;
  /** Inputs the source maps that the target step lacks. */
  missing?: string[];
  /** Inputs whose value differs (path: source → target). */
  changed?: string[];
  /** Inputs only the target maps. */
  extra?: string[];
  /** The step itself differs (absent on the target, or another callee). */
  note?: string;
}

/** Step-by-step input mappings of the source body vs the target's. */
export function compareStepMappings(source: Obj, target: Obj): StepDifference[] {
  const src = stepMappingsOf(source);
  const tgt = stepMappingsOf(target);
  const diffs: StepDifference[] = [];
  for (const a of src) {
    const b = tgt[a.step - 1];
    if (!b) {
      diffs.push({ step: a.step, callee: a.callee, note: "step missing on the target" });
      continue;
    }
    if (b.callee !== a.callee) {
      diffs.push({ step: a.step, callee: a.callee, note: `target step calls ${b.callee}` });
      continue;
    }
    const missing = Object.keys(a.inputs).filter((k) => !(k in b.inputs));
    const changed = Object.keys(a.inputs).filter((k) => k in b.inputs && b.inputs[k] !== a.inputs[k]);
    const extra = Object.keys(b.inputs).filter((k) => !(k in a.inputs));
    if (missing.length + changed.length + extra.length === 0) continue;
    diffs.push({
      step: a.step,
      callee: a.callee,
      ...(missing.length ? { missing } : {}),
      ...(changed.length ? { changed: changed.map((k) => `${k}: ${a.inputs[k]} → ${b.inputs[k]}`) } : {}),
      ...(extra.length ? { extra } : {}),
    });
  }
  for (const b of tgt.slice(src.length)) diffs.push({ step: b.step, callee: b.callee, note: "step only on the target" });
  return diffs;
}

/** One line per difference, for warnings. */
export function describeStepDifference(d: StepDifference): string {
  const parts = [
    d.note,
    d.missing ? `missing on target: ${d.missing.join(", ")}` : undefined,
    d.changed ? `changed: ${d.changed.join("; ")}` : undefined,
    d.extra ? `only on target: ${d.extra.join(", ")}` : undefined,
  ].filter(Boolean);
  return `step ${d.step} (${d.callee}) ${parts.join("; ")}`;
}

export interface StepCheck {
  sourceEnv?: string;
  targetEnv?: string;
  /** Migrated methods whose target steps map inputs differently from the source. */
  methods: Array<{ id: string; name?: string; differences: StepDifference[] }>;
  /** Ids whose bodies could not be compared, with why. */
  errors?: Array<{ id: string; error: string }>;
  /** Why nothing was compared. */
  skipped?: string;
}

async function readBodies(ids: readonly string[], env: string): Promise<Map<string, Obj | Error | null>> {
  const out = new Map<string, Obj | Error | null>();
  const restore = Config.captureActiveEnv();
  try {
    Config.setActiveEnv(env);
    for (const id of ids) {
      try {
        out.set(id, await fetchChainV2(id));
      } catch (e) {
        out.set(id, e instanceof Error ? e : new Error(String(e)));
      }
    }
  } finally {
    restore();
  }
  return out;
}

/**
 * After a migration: compare each migrated method's step input mappings on
 * the target with the source. Never throws; unknown or unconfigured envs give
 * `skipped`.
 */
export async function checkTargetSteps(ids: readonly string[], sourceEnv: string | undefined, targetEnv: string | undefined): Promise<StepCheck> {
  const base = { sourceEnv, targetEnv, methods: [] as StepCheck["methods"] };
  if (!sourceEnv || !targetEnv) return { ...base, skipped: "the profile's source/target envs are unknown" };
  const envs = Config.getAllEnvs();
  const missing = [sourceEnv, targetEnv].filter((e) => !envs[e]);
  if (missing.length > 0) return { ...base, skipped: `env ${missing.map((e) => `'${e}'`).join(" and ")} not configured` };
  const source = await readBodies(ids, sourceEnv);
  const target = await readBodies(ids, targetEnv);
  const errors: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    const a = source.get(id);
    const b = target.get(id);
    if (a instanceof Error || b instanceof Error || !a || !b) {
      const why = a instanceof Error ? `source: ${a.message}` : !a ? `not found on ${sourceEnv}` : b instanceof Error ? `target: ${b.message}` : `not found on ${targetEnv}`;
      errors.push({ id, error: why });
      continue;
    }
    const differences = compareStepMappings(a, b);
    if (differences.length > 0) base.methods.push({ id, name: s(a.name), differences });
  }
  return { ...base, ...(errors.length ? { errors } : {}) };
}
