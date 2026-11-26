// What only a method's V1 body holds: the V2 route neither shows it nor keeps
// it, so `ad show` (V2 views) and `ad save` (a V2 POST) read it from V1.
//
//   - Legacy loops (K1). The older editor stored a step's loop as
//     `loopExecutionSource` alone (no `repeatStepExecution`, no
//     `loopConfiguration`; live: hundreds of such steps). The V2 GET has no
//     `properties.repeatStepExecution` for them, so a V2 save posts the step
//     back without its loop. The save writes it into the V2 body instead
//     ("each" over the source, the form the server itself stores).
//   - Dropped input mappings (K5). A V1 step keeps mappings for callee inputs
//     that no longer exist (no label; `ad show --step` prints `#<id>`). The V2
//     GET leaves them out, so every V2 save drops them from the stored body.
//
// V1 services and V2 steps are matched by position, and only when both bodies
// have the same number of steps.

import { isObj, type Obj } from "@belzabar/core";
import * as v1 from "./api/v1";
import type { ApiContract, ContractInput } from "./validate/online";
import type { V2OverlayPlan } from "./serialize/v2";
import type { V2Step } from "./types/v2-wire";
import type { HydratedMethod } from "./types/common";
import { EACH_LOOP, legacyLoopSource } from "./parser/steps/shared";


/** The parsed V1 `jsonDefinition` of a raw V1 chain, or null. */
export function v1Definition(raw: unknown): Obj | null {
  if (!isObj(raw)) return null;
  try {
    const def = typeof raw.jsonDefinition === "string" ? JSON.parse(raw.jsonDefinition) : raw.jsonDefinition;
    return isObj(def) ? def : null;
  } catch {
    return null;
  }
}

/** The V1 definition of `uuid`, or null when the read fails (best effort: never blocks a save or a view). */
export async function readV1Definition(uuid: string): Promise<Obj | null> {
  try {
    return v1Definition(await v1.fetchRawMethod(uuid));
  } catch {
    return null;
  }
}

/** V1 steps in order, or null when they cannot be matched to `steps` by position. */
function alignedServices(def: Obj | null, steps: unknown): Obj[] | null {
  const services = Array.isArray(def?.services) ? (def!.services as unknown[]).filter(isObj) : [];
  const n = Array.isArray(steps) ? steps.length : 0;
  if (services.length === 0 || services.length !== n) return null;
  return [...services].sort((a, b) => Number(a.orderIndex ?? 0) - Number(b.orderIndex ?? 0));
}

function hasV2Loop(step: V2Step | undefined): boolean {
  const rse = step?.properties?.repeatStepExecution as Obj | null | undefined;
  return isObj(rse) && Object.values(rse).some((v) => v !== null && v !== undefined && v !== false && v !== "");
}

export interface LegacyLoop {
  /** Step position (1-based) in the fetched draft. */
  step: number;
  over: string;
}

/** Steps whose loop is stored only in V1 (the V2 `steps` have none for them). */
export function legacyLoops(def: Obj | null, steps: V2Step[] | undefined): LegacyLoop[] {
  const services = alignedServices(def, steps);
  if (!services) return [];
  const out: LegacyLoop[] = [];
  services.forEach((svc, i) => {
    const over = legacyLoopSource(svc);
    if (over && !hasV2Loop(steps![i])) out.push({ step: i + 1, over });
  });
  return out;
}

/** The V2 loop the server stores for a V1 "each" loop. */
export function v2EachLoop(over: string): Obj {
  return { type: EACH_LOOP, counter: null, executeParallel: false, numberOfConcurrentThread: null, value: over };
}

/** Fetched step positions whose loop an `update-step` op sets or clears (`set.loop`): the overlay decides those. */
function loopsSetByOps(overlay: unknown): Set<number> {
  const ops = isObj(overlay) && Array.isArray(overlay.ops) ? overlay.ops : [];
  return new Set(ops.filter((o): o is Obj => isObj(o) && o.op === "update-step" && isObj(o.set) && "loop" in o.set).map((o) => Number(o.step)));
}

/**
 * Write every legacy loop into the planned body (steps the ops removed or
 * whose loop they set are skipped), and add each to what the post-save verify
 * checks. Returns the loops carried.
 */
export function carryLegacyLoops(plan: V2OverlayPlan, loops: LegacyLoop[], overlay: unknown): LegacyLoop[] {
  const setByOps = loopsSetByOps(overlay);
  const carried: LegacyLoop[] = [];
  for (const l of loops) {
    if (setByOps.has(l.step)) continue;
    const at = plan.structural ? plan.structural.order.indexOf(l.step) : l.step - 1;
    const step = plan.body.steps?.[at];
    if (at < 0 || !step || !isObj(step.properties) || hasV2Loop(step)) continue;
    const value = v2EachLoop(l.over);
    step.properties.repeatStepExecution = value as never;
    const path = `steps[${at}].properties.repeatStepExecution`;
    if (plan.structural) plan.structural.touched.push(path);
    else plan.targets.push({ key: `loop carried: step ${l.step}`, path, value });
    carried.push(l);
  }
  return carried;
}

export function loopsCarriedWarning(loops: LegacyLoop[], tense: "carried" | "will be carried"): string {
  return (
    `Loop ${tense} into the V2 body for step(s) ${loops.map((l) => `${l.step} (each ${l.over})`).join(", ")}: the older editor ` +
    `stored it only in the V1 body, which the V2 route does not read, so a save would drop it.`
  );
}

/**
 * The V2 views (`show --compact` / `--story`, `outputs`): mark the legacy
 * loops on the parsed V2 steps (`legacyLoop`), from a V1 read. Returns them.
 */
export async function applyLegacyLoops(method: HydratedMethod, rawV2Steps: V2Step[] | undefined): Promise<LegacyLoop[]> {
  if (method.sourceVersion !== "v2" || !Array.isArray(rawV2Steps) || rawV2Steps.length === 0) return [];
  const loops = legacyLoops(await readV1Definition(method.uuid), rawV2Steps);
  for (const l of loops) {
    const s = method.parsedSteps.find((p) => p.orderIndex === l.step);
    if (!s || s.repeatStepExecution) continue;
    s.repeatStepExecution = true;
    s.loopExecutionSource = l.over;
    s.loopConfiguration = { ...(s.loopConfiguration ?? {}), type: EACH_LOOP };
    s.legacyLoop = true;
  }
  return loops;
}

export function legacyLoopShowWarning(loops: LegacyLoop[]): string {
  return (
    `Step(s) ${loops.map((l) => l.step).join(", ")} loop in the V1 body only (older editor; the V2 route shows no loop). ` +
    `Shown as "loop each … (v1 only)"; \`wi-impl ad save\` carries the loop into the V2 body.`
  );
}

// ── input mappings the V2 body no longer carries (K5) ─────────────────────

export interface DroppedMapping {
  /** Step position (1-based) in the fetched draft. */
  step: number;
  /** The callee input: its label when V1 has one, else `#<automationUserInputId>` (as `ad show --step` prints it). */
  input: string;
  value?: string;
}

function ids(level: ContractInput[] | undefined, out = { ids: new Set<string>(), uuids: new Set<string>() }) {
  for (const c of level ?? []) {
    if (c.id !== undefined && c.id !== null) out.ids.add(String(c.id));
    if (typeof c.uuid === "string") out.uuids.add(c.uuid.trim().toLowerCase());
  }
  return out;
}

/** Steps with more top-level V1 mappings than V2 inputs: the only ones that can lose a mapping. */
export function mappingCandidates(def: Obj | null, steps: V2Step[] | undefined): Array<{ step: number; mappings: Obj[] }> {
  const services = alignedServices(def, steps);
  if (!services) return [];
  const out: Array<{ step: number; mappings: Obj[] }> = [];
  services.forEach((svc, i) => {
    const mappings = (Array.isArray(svc.mappings) ? svc.mappings : []).filter(isObj);
    const inputs = Array.isArray(steps![i]!.inputs) ? steps![i]!.inputs!.length : 0;
    if (mappings.length > inputs) out.push({ step: i + 1, mappings });
  });
  return out;
}

/**
 * The V1 mappings each candidate step loses on a V2 save: the ones whose
 * callee input (id / uuid) the callee contract no longer has. A step whose
 * contract is unknown is skipped (V1 and V2 input uuids differ, so nothing
 * else names the mapping reliably).
 */
export function droppedMappings(
  candidates: Array<{ step: number; mappings: Obj[] }>,
  steps: V2Step[] | undefined,
  contractOf: (step: V2Step) => ApiContract | null | undefined,
): DroppedMapping[] {
  const out: DroppedMapping[] = [];
  for (const c of candidates) {
    const step = steps?.[c.step - 1];
    if (!step) continue;
    const contract = contractOf(step);
    if (!contract) continue;
    const known = ids(contract.automationUserInputs);
    for (const m of c.mappings) {
      const id = m.automationUserInputId;
      const uuid = typeof m.automationUserInputUuid === "string" ? m.automationUserInputUuid.trim().toLowerCase() : "";
      if ((id !== undefined && id !== null && known.ids.has(String(id))) || (uuid && known.uuids.has(uuid))) continue;
      const label = isObj(m.automationUserInput) && typeof m.automationUserInput.produces === "string" ? m.automationUserInput.produces : undefined;
      out.push({ step: c.step, input: label ?? `#${String(id ?? uuid)}`, ...(typeof m.value === "string" ? { value: m.value } : {}) });
    }
  }
  return out;
}

export function droppedMappingsWarning(dropped: DroppedMapping[], tense: "dropped" | "will be dropped"): string {
  return (
    `Input mapping(s) ${tense} by the save: ${dropped.map((d) => `step ${d.step} ${d.input}${d.value !== undefined ? ` = ${JSON.stringify(d.value)}` : ""}`).join("; ")}. ` +
    `The callee no longer has these inputs; the V1 body still kept them, the V2 save does not.`
  );
}
