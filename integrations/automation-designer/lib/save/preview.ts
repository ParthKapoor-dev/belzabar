// What `ad save --dry-run` shows of a plan beyond the applied labels: the
// before/after value of every changed field, the new step order with new
// steps named `new#1`, `new#2`…, and which step outputs map to a method
// output. Pure.

import { isObj } from "@belzabar/core";
import { decodeBase64Strict } from "../base64";
import { diffPaths, getAtPath, pathSegments } from "../serialize/diff";
import type { V2OverlayPlan } from "../serialize/v2";
import type { V2MethodResponse } from "../types/v2-wire";

export interface PlannedChange {
  /** What changes: an overlay key, `step N` (fetched position), or `input k` / `output k` / `variable k`. */
  target: string;
  /** Wire path in the body that would be saved. */
  path: string;
  /** Stored value (code and base64 SQL decoded to text); undefined = absent. */
  before: unknown;
  after: unknown;
}

/** A base64-stored code or SQL value as text, anything else as is. */
function readable(root: unknown, path: string, v: unknown): unknown {
  if (typeof v !== "string" || v === "") return v;
  const last = path.split(".").pop();
  const parent = getAtPath(root, path.replace(/\.[^.]+$/, ""));
  const b64 = last === "inlineCode" || (last === "value" && isObj(parent) && parent.encodingType === "BASE_64");
  return b64 ? decodeBase64Strict(v) ?? v : v;
}

function leafChanges(target: string, live: unknown, body: unknown, from: string, to: string): PlannedChange[] {
  const a = from ? getAtPath(live, from) : live;
  const b = to ? getAtPath(body, to) : body;
  return diffPaths(a, b).map((p) => {
    const sub = p === "$" ? "" : p.startsWith("[") ? p : `.${p}`;
    return {
      target,
      path: `${to}${sub}`,
      before: readable(live, `${from}${sub}`, getAtPath(live, `${from}${sub}`)),
      after: readable(body, `${to}${sub}`, getAtPath(body, `${to}${sub}`)),
    };
  });
}

/** Every field the plan changes, with its value before and after. */
export function previewChanges(live: V2MethodResponse, plan: V2OverlayPlan): PlannedChange[] {
  if (!plan.structural) {
    return plan.targets.map((t) => ({ target: t.key, path: t.path, before: readable(live, t.path, getAtPath(live, t.path)), after: readable(plan.body, t.path, t.value) }));
  }
  const out: PlannedChange[] = [];
  const { order, touched } = plan.structural;
  for (const t of touched) {
    const step = /^steps\[(\d+)\]$/.exec(t);
    if (step) {
      const from = order[Number(step[1])];
      if (from === null || from === undefined) continue; // a new step: named in `order`
      out.push(...leafChanges(`step ${from}`, live, plan.body, `steps[${from - 1}]`, t));
      continue;
    }
    const field = /^(inputs|outputs|variables)\[(\d+)\]$/.exec(t);
    if (field) {
      const f = getAtPath(plan.body, t);
      const key = isObj(f) ? f.key : undefined;
      const list = (live as Record<string, unknown>)[field[1]!];
      const at = Array.isArray(list) ? list.findIndex((x) => isObj(x) && x.key === key) : -1;
      const kind = field[1]!.slice(0, -1);
      if (at < 0) out.push({ target: `${kind} ${String(key)}`, path: t, before: undefined, after: f });
      else out.push(...leafChanges(`${kind} ${String(key)}`, live, plan.body, `${field[1]}[${at}]`, t));
      continue;
    }
    out.push({ target: t, path: t, before: readable(live, t, getAtPath(live, t)), after: readable(plan.body, t, getAtPath(plan.body, t)) });
  }
  // method fields the ops removed
  for (const list of ["inputs", "outputs", "variables"] as const) {
    const now = new Set(((plan.body[list] ?? []) as unknown[]).filter(isObj).map((f) => f.key));
    for (const f of ((live[list] ?? []) as unknown[]).filter(isObj)) {
      if (typeof f.key === "string" && !now.has(f.key)) out.push({ target: `${list.slice(0, -1)} ${f.key}`, path: list, before: f, after: undefined });
    }
  }
  return out;
}

/** The new step order: fetched positions, new steps as `new#1`, `new#2`… */
export function namedOrder(order: Array<number | null>): Array<number | string> {
  let n = 0;
  return order.map((from) => (from === null ? `new#${++n}` : from));
}

/**
 * Step outputs (of the steps the plan adds or edits) that the method returns:
 * their name (fieldCode) is a method output.
 */
export function outputsToMethod(plan: V2OverlayPlan, order?: Array<number | string>): Array<{ step: number | string; output: string }> {
  const methodOutputs = new Set(((plan.body.outputs ?? []) as unknown[]).filter(isObj).flatMap((o) => [o.key, o.fieldCode]).filter((k): k is string => typeof k === "string"));
  const steps = plan.structural
    ? plan.structural.touched.filter((t) => /^steps\[\d+\]$/.test(t)).map((t) => Number(pathSegments(t)[1]))
    : [];
  const out: Array<{ step: number | string; output: string }> = [];
  for (const i of steps) {
    const s = plan.body.steps?.[i];
    for (const o of (s?.outputs ?? []) as unknown[]) {
      if (isObj(o) && typeof o.fieldCode === "string" && methodOutputs.has(o.fieldCode)) out.push({ step: order?.[i] ?? i + 1, output: o.fieldCode });
    }
  }
  return out;
}
