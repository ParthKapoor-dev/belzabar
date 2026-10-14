// Structural `ad save` ops: add / remove / move / update steps and
// upsert / remove method inputs, outputs and variables, on top of the live V2
// body. Steps are always named by their position in the FETCHED draft (the
// numbers `wi-impl ad show` prints), whatever other ops do, so an agent can write
// every op from one read. New steps and moves are placed with `after: N` /
// `before: N` (anchors are fetched positions; `after: 0` = first; no anchor =
// append). Several steps placed after the same anchor keep op order.
//
//   {"op":"add-step",    "after":2, "step":{…compact step…}}
//   {"op":"remove-step", "step":3}
//   {"op":"move-step",   "step":4, "before":1}
//   {"op":"update-step", "step":2, "set":{…compact fields…, "removeOutputs":["x"]}}
//   {"op":"set-input" | "set-variable" | "set-output", "key":"k", …field}   upsert
//   {"op":"remove-input" | "remove-variable" | "remove-output", "key":"k"}
//
// Pure. Returns the new body plus the paths (in the new body) that the post-save
// verify treats as touched; everything else must read back unchanged.

import type { V2MethodResponse, V2Step } from "../types/v2-wire";
import type { ParseOptions } from "../parser/steps/classify";
import { parseV2Step } from "../parser/steps/v2";
import {
  applyStepFields,

  expandCompactStep,
  expandField,
  mergeField,
  Problems,
  STEP_SET_KEYS,
  type FieldKind,
  type ServiceCatalog,
} from "./compact";
import { isObj, type Obj } from "@belzabar/core";

export const OP_NAMES = [
  "add-step",
  "remove-step",
  "move-step",
  "update-step",
  "set-input",
  "remove-input",
  "set-variable",
  "remove-variable",
  "set-output",
  "remove-output",
] as const;

const OP_KEYS: Record<string, Set<string>> = {
  "add-step": new Set(["op", "after", "before", "step"]),
  "remove-step": new Set(["op", "step"]),
  "move-step": new Set(["op", "step", "after", "before"]),
  "update-step": new Set(["op", "step", "set"]),
};
const FIELD_OP = /^(set|remove)-(input|variable|output)$/;
const LIST_OF: Record<string, "inputs" | "variables" | "outputs"> = { input: "inputs", variable: "variables", output: "outputs" };

interface StructuralResult {
  body: V2MethodResponse;
  /** Paths in `body` that were written (new/updated steps and fields). */
  touched: string[];
  /** Human labels, one per op. */
  applied: string[];
  /** Fetched positions removed / updated (for the L0 drift check). */
  removed: number[];
  updated: number[];
  /** New step order: fetched position, or null for a new step. */
  order: Array<number | null>;
}

interface Entry {
  from: number | null;
  step: V2Step;
  touched: boolean;
}

/** `"svc/method"` of an existing V2 step, when it names one. */
export function stepService(s: V2Step): string | null {
  return typeof s.serviceName === "string" && typeof s.methodName === "string" ? `${s.serviceName.trim()}/${s.methodName.trim()}` : null;
}

/** Step kind the way the save overlay treats it (CUSTOM_CODE / SQL / SPEL_ECHO / …). */
function stepKind(s: V2Step, pos: number, opts: ParseOptions): string {
  return parseV2Step(s, pos, () => {}, opts).kind;
}

/**
 * Apply `ops` to `body` (already a private copy; mutated). `lockedSteps` are
 * fetched positions with legacy parsedSteps edits (they may not be removed).
 */
export function applyStructuralOps(
  body: V2MethodResponse,
  ops: unknown,
  ctx: { catalog: ServiceCatalog; p: Problems; parse: ParseOptions; lockedSteps: Set<number> },
): StructuralResult {
  const { p, catalog } = ctx;
  const res: StructuralResult = { body, touched: [], applied: [], removed: [], updated: [], order: [] };
  if (!Array.isArray(ops)) {
    p.bad("ops", "must be an array of {op, …}");
    return res;
  }
  const live = Array.isArray(body.steps) ? body.steps : [];
  const n = live.length;
  const entries: Entry[] = live.map((step, i) => ({ from: i + 1, step, touched: false }));
  const touchedFields: Record<string, Set<string>> = { inputs: new Set(), variables: new Set(), outputs: new Set() };

  const posOk = (v: unknown, key: string, allowZero = false): v is number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < (allowZero ? 0 : 1) || v > n) {
      p.bad(key, `must be a step position 1..${n}${allowZero ? " (or 0 = before the first step)" : ""} of the fetched draft`);
      return false;
    }
    return true;
  };
  const removed = new Set<number>();
  const moved = new Set<number>();
  const updatedSet = new Set<number>();
  const lastAfter = new Map<string, Entry>();

  /** Insert `e` at the anchor named by `after` / `before`; returns false on a bad anchor. */
  const place = (e: Entry, op: Obj, where: string): boolean => {
    if ("after" in op && "before" in op) {
      p.bad(where, "give after or before, not both");
      return false;
    }
    let anchorKey: string;
    let idx: number;
    if ("before" in op) {
      if (!posOk(op.before, `${where}.before`)) return false;
      if (removed.has(op.before)) return (p.bad(`${where}.before`, `step ${op.before} is removed by another op`), false);
      if (e.from === op.before) return (p.bad(`${where}.before`, "cannot place a step relative to itself"), false);
      anchorKey = `b${op.before}`;
      const prev = lastAfter.get(anchorKey);
      idx = prev ? entries.indexOf(prev) + 1 : entries.findIndex((x) => x.from === op.before);
    } else if ("after" in op) {
      if (!posOk(op.after, `${where}.after`, true)) return false;
      if (removed.has(op.after)) return (p.bad(`${where}.after`, `step ${op.after} is removed by another op`), false);
      if (e.from === op.after) return (p.bad(`${where}.after`, "cannot place a step relative to itself"), false);
      anchorKey = `a${op.after}`;
      const prev = lastAfter.get(anchorKey);
      idx = prev ? entries.indexOf(prev) + 1 : op.after === 0 ? 0 : entries.findIndex((x) => x.from === op.after) + 1;
    } else {
      anchorKey = "end";
      idx = entries.length;
    }
    entries.splice(idx, 0, e);
    lastAfter.set(anchorKey, e);
    return true;
  };

  ops.forEach((raw, i) => {
    const where = `ops[${i}]`;
    if (!isObj(raw) || typeof raw.op !== "string") {
      p.bad(where, `must be an object with op (${OP_NAMES.join(", ")})`);
      return;
    }
    const op = raw.op;
    const fieldOp = FIELD_OP.exec(op);
    if (!OP_KEYS[op] && !fieldOp) {
      p.unknown.push(`${where}.op=${op}`);
      return;
    }
    if (OP_KEYS[op]) for (const k of Object.keys(raw)) if (!OP_KEYS[op]!.has(k)) p.unknown.push(`${where}.${k}`);

    if (op === "add-step") {
      const step = expandCompactStep(raw.step, catalog, `${where}.step`, p);
      if (!step) return;
      const e: Entry = { from: null, step, touched: true };
      if (place(e, raw, where)) res.applied.push(`add-step ${describeStep(raw.step)}${anchorLabel(raw)}`);
      return;
    }
    if (op === "remove-step") {
      if (!posOk(raw.step, `${where}.step`)) return;
      const s = raw.step;
      if (removed.has(s)) return p.bad(`${where}.step`, `step ${s} is removed twice`);
      if (updatedSet.has(s) || moved.has(s) || ctx.lockedSteps.has(s)) return p.bad(`${where}.step`, `step ${s} is also edited/moved by another op`);
      if ([...lastAfter.keys()].some((k) => k === `a${s}` || k === `b${s}`)) return p.bad(`${where}.step`, `step ${s} is an anchor of another op`);
      removed.add(s);
      entries.splice(entries.findIndex((x) => x.from === s), 1);
      res.applied.push(`remove-step ${s}`);
      return;
    }
    if (op === "move-step") {
      if (!posOk(raw.step, `${where}.step`)) return;
      const s = raw.step;
      if (removed.has(s)) return p.bad(`${where}.step`, `step ${s} is removed by another op`);
      if (moved.has(s)) return p.bad(`${where}.step`, `step ${s} is moved twice`);
      if (!("after" in raw) && !("before" in raw)) return p.bad(where, "move-step needs after or before");
      const cur = entries.findIndex((x) => x.from === s);
      const [e] = entries.splice(cur, 1);
      if (!place(e!, raw, where)) {
        entries.splice(cur, 0, e!);
        return;
      }
      moved.add(s);
      res.applied.push(`move-step ${s}${anchorLabel(raw)}`);
      return;
    }
    if (op === "update-step") {
      if (!posOk(raw.step, `${where}.step`)) return;
      const s = raw.step;
      if (removed.has(s)) return p.bad(`${where}.step`, `step ${s} is removed by another op`);
      if (!isObj(raw.set)) return p.bad(`${where}.set`, "must be an object of compact step fields");
      for (const k of Object.keys(raw.set)) {
        if (k === "service") p.bad(`${where}.set.service`, "a step's service cannot change; remove-step + add-step instead");
        else if (k === "codeFile" || k === "sqlFile") p.bad(`${where}.set.${k}`, "was not resolved to its file contents");
        else if (!STEP_SET_KEYS.has(k)) p.unknown.push(`${where}.set.${k}`);
      }
      const e = entries.find((x) => x.from === s)!;
      const kind = stepKind(e.step, s, ctx.parse);
      const changed = applyStepFields(e.step, raw.set, {
        kind,
        service: stepService(e.step),
        catalog,
        where: `${where}.set`,
        p,
        isNew: false,
      });
      e.touched = true;
      updatedSet.add(s);
      if (changed.length) res.applied.push(`update-step ${s} (${changed.join(", ")})`);
      return;
    }
    // method-level fields
    const [, verb, kindName] = fieldOp!;
    const kind = kindName as FieldKind;
    const list = LIST_OF[kind]!;
    const arr = ((body as Record<string, unknown>)[list] ??= []) as Obj[];
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!key) return p.bad(`${where}.key`, "required");
    const idx = arr.findIndex((f) => isObj(f) && f.key === key);
    if (verb === "remove") {
      for (const k of Object.keys(raw)) if (k !== "op" && k !== "key") p.unknown.push(`${where}.${k}`);
      if (idx < 0) return p.drop(`${where}.key`, `the method has no ${kind} '${key}'`);
      arr.splice(idx, 1);
      touchedFields[list]!.delete(key);
      res.applied.push(`remove-${kind} ${key}`);
      return;
    }
    const given: Obj = { ...raw };
    delete given.op;
    if (idx >= 0) {
      arr[idx] = mergeField(arr[idx]!, given, kind, where, p);
      res.applied.push(`set-${kind} ${key} (updated)`);
    } else {
      const f = expandField(given, kind, where, p);
      if (!f) return;
      arr.push(f);
      res.applied.push(`set-${kind} ${key} (new)`);
    }
    touchedFields[list]!.add(key);
  });

  body.steps = entries.map((e) => e.step);
  res.order = entries.map((e) => e.from);
  entries.forEach((e, i) => {
    if (e.touched) res.touched.push(`steps[${i}]`);
  });
  for (const [list, keys] of Object.entries(touchedFields)) {
    const arr = ((body as Record<string, unknown>)[list] ?? []) as Obj[];
    arr.forEach((f, i) => {
      if (isObj(f) && typeof f.key === "string" && keys.has(f.key)) res.touched.push(`${list}[${i}]`);
    });
  }
  res.removed = [...removed];
  res.updated = [...updatedSet];
  return res;
}


function anchorLabel(op: Obj): string {
  if ("before" in op) return ` before ${String(op.before)}`;
  if ("after" in op) return ` after ${String(op.after)}`;
  return " at the end";
}

function describeStep(s: unknown): string {
  if (!isObj(s)) return "?";
  if (typeof s.service === "string") return s.service;
  if ("code" in s) return "custom code";
  if ("sql" in s) return "sql";
  return "?";
}


