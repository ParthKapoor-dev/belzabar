// `ad save` overlay → V2 save body (the save route is
// `GET /chain/v2/{uuid}` → overlay → `POST /chain/v2`).
//
// The body sent is the live V2 GET body with ONLY the overlay's target leaves
// replaced. Everything else — metadata (state, version, service, internal),
// step ids, padded uuids, changelogs, permissions — is passed back verbatim,
// which is what the server's "Invalid state, provided state does not match"
// check requires. Custom code is written in the step's stored encoding; SQL in
// its slot's `encodingType`.
//
// Guarantees:
//   1. Unknown overlay keys → AD_OVERLAY_UNKNOWN_KEY; bad value types →
//      AD_OVERLAY_INVALID.
//   2. Keys that cannot land → AD_OVERLAY_NOT_APPLIED: missing/ambiguous step,
//      a field on a step of another kind, and fields the V2 route silently
//      drops (buttonLabel, internalMethod, inputs[].testValue — live
//      2026-09-28: 200 OK, absent from the next GET and from V1).
//   3. L0: the body differs from the live body only at target paths
//      (AD_SERIALIZER_DRIFT otherwise) — metadata can never change.
//   4. Effect: an overlay that changes nothing → AD_OVERLAY_NOT_APPLIED; a
//      single no-op key next to real changes is reported in `unchanged`.
//
// Pure: no network.

import { CliError, isObj } from "@belzabar/core";
import type { V2MethodResponse, V2Step } from "../types/v2-wire";
import { decodeBase64Strict, encodeBase64 } from "../base64";
import { parseV2Step } from "../parser/steps/v2";
import type { ParseOptions } from "../parser/steps/classify";
import { diffPaths, getAtPath, isUnder, jsonEqual, pathSegments } from "./diff";
import { emptyCatalog, encodeSql, findSqlSlot, Problems, type ServiceCatalog } from "./compact";
import { applyStructuralOps, OP_NAMES } from "./ops";

export { encodeSql };

const TOP_LEVEL_KEYS = new Set(["name", "summary", "description", "buttonLabel", "internalMethod", "inputs", "parsedSteps", "ops"]);
const INPUT_KEYS = new Set(["code", "testValue"]);
const STEP_KEYS = new Set(["orderIndex", "source", "sql", "expression", "description"]);

/** Fields the V2 save route accepts with 200 and then drops (verified live). */
const DROPPED_BY_V2 = new Set(["buttonLabel", "internalMethod"]);

interface NotAppliedEntry {
  key: string;
  reason: string;
}

/** One leaf the save writes: overlay key, wire path, the exact wire value. */
export interface OverlayTarget {
  key: string;
  path: string;
  value: unknown;
}

export interface V2OverlayPlan {
  /** The body to POST: a deep copy of `live` with the targets applied. */
  body: V2MethodResponse;
  /** Targets that change the body (post-save verify checks exactly these). */
  targets: OverlayTarget[];
  applied: string[];
  /** Overlay keys whose value already equals the draft (warned, not refused). */
  unchanged: string[];
  /**
   * Present when the overlay has structural `ops`: the post-save verify then
   * compares the whole body, tolerating server-filled fields (ids, uuids,
   * types) only under `touched` (paths in `body`).
   */
  structural?: { touched: string[]; order: Array<number | null> };
}

interface PlanOptions extends ParseOptions {
  /** Callee contracts + db accounts for ops (lib/save/services.ts loadServiceCatalog). */
  catalog?: ServiceCatalog;
}

interface PlannedEdit {
  key: string;
  path: string;
  value: unknown;
}

/**
 * Apply an `ad save` overlay to a live V2 body. Throws CliError with a stable
 * code on any refusal (see file header). `live` is never mutated.
 */
export function planV2Overlay(live: V2MethodResponse, overlay: unknown, opts: PlanOptions = {}): V2OverlayPlan {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
    throw new CliError("Overlay must be a JSON object.", { code: "AD_OVERLAY_INVALID" });
  }
  const o = overlay as Record<string, unknown>;
  checkKnownKeys(o);

  const edits: PlannedEdit[] = [];
  const notApplied: NotAppliedEntry[] = [];
  const invalid: NotAppliedEntry[] = [];

  // ── method-level keys ─────────────────────────────────────────────────
  for (const key of DROPPED_BY_V2) {
    if (key in o) notApplied.push({ key, reason: "the V2 save route drops it (200, but absent from the next GET)" });
  }
  for (const key of ["name", "summary", "description"] as const) {
    if (!(key in o)) continue;
    const v = o[key];
    if (typeof v !== "string") invalid.push({ key, reason: "must be a string" });
    else if (key === "name" && v.trim().length === 0) invalid.push({ key, reason: "must not be empty" });
    else edits.push({ key, path: key, value: v });
  }

  // ── inputs[] ──────────────────────────────────────────────────────────
  if ("inputs" in o) {
    if (!Array.isArray(o.inputs)) invalid.push({ key: "inputs", reason: "must be an array" });
    else {
      o.inputs.forEach((entry, i) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          invalid.push({ key: `inputs[${i}]`, reason: "must be an object {code, testValue}" });
          return;
        }
        const e = entry as Record<string, unknown>;
        const code = typeof e.code === "string" ? e.code : `#${i}`;
        notApplied.push({
          key: `inputs[code=${code}].testValue`,
          reason: "stored testValues are dropped by every save (V2 route verified live); pass inputs to `ad test` instead",
        });
      });
    }
  }

  // ── parsedSteps[] ─────────────────────────────────────────────────────
  const steps: V2Step[] = Array.isArray(live.steps) ? live.steps : [];
  if ("parsedSteps" in o) {
    if (!Array.isArray(o.parsedSteps)) invalid.push({ key: "parsedSteps", reason: "must be an array" });
    else {
      const seen = new Set<string>();
      o.parsedSteps.forEach((entry, i) => {
        const where = `parsedSteps[${i}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          invalid.push({ key: where, reason: "must be an object with orderIndex" });
          return;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.orderIndex !== "number" || !Number.isInteger(e.orderIndex)) {
          invalid.push({ key: `${where}.orderIndex`, reason: "must be an integer (1-based step position)" });
          return;
        }
        const idx = e.orderIndex;
        const label = (f: string) => `parsedSteps[orderIndex=${idx}].${f}`;
        const fields = Object.keys(e).filter((k) => k !== "orderIndex");
        for (const f of fields) {
          if (typeof e[f] !== "string") invalid.push({ key: label(f), reason: "must be a string" });
          if (seen.has(label(f))) invalid.push({ key: label(f), reason: "given twice" });
          seen.add(label(f));
        }
        const raw = steps[idx - 1];
        if (idx < 1 || !raw) {
          for (const f of fields) notApplied.push({ key: label(f), reason: `no step with orderIndex ${idx} (method has ${steps.length})` });
          return;
        }
        const base = `steps[${idx - 1}]`;
        const parsed = parseV2Step(raw, idx, () => {}, opts);
        for (const f of fields) {
          const value = e[f];
          if (typeof value !== "string") continue;
          if (f === "description") {
            edits.push({ key: label(f), path: `${base}.description`, value });
            continue;
          }
          if (f === "source") {
            if (parsed.kind !== "CUSTOM_CODE") {
              notApplied.push({ key: label(f), reason: `step ${idx} is ${parsed.kind}, not CUSTOM_CODE` });
              continue;
            }
            const current = raw.properties?.customCode?.inlineCode;
            edits.push({ key: label(f), path: `${base}.properties.customCode.inlineCode`, value: encodeSource(current, value) });
            continue;
          }
          if (f === "sql") {
            if (parsed.kind !== "SQL") {
              notApplied.push({ key: label(f), reason: `step ${idx} is ${parsed.kind}, not SQL (service ${raw.serviceName ?? "?"}/${raw.methodName ?? "?"})` });
              continue;
            }
            const slot = findSqlSlot(raw.inputs, `${base}.inputs`);
            if (!slot) {
              notApplied.push({ key: label(f), reason: `step ${idx} has no queryString input to write the SQL into` });
              continue;
            }
            edits.push({ key: label(f), path: `${slot.path}.value`, value: encodeSql(slot.input, value) });
            continue;
          }
          // expression
          if (parsed.kind !== "SPEL_ECHO") {
            notApplied.push({ key: label(f), reason: `step ${idx} is ${parsed.kind}, not SPEL_ECHO` });
            continue;
          }
          if (!Array.isArray(raw.inputs) || raw.inputs.length === 0) {
            notApplied.push({ key: label(f), reason: `echo step ${idx} has no input to hold the expression` });
            continue;
          }
          edits.push({ key: label(f), path: `${base}.inputs[0].value`, value });
        }
      });
    }
  }

  // ── structural ops (fetched step positions; see ops.ts) ───────────────
  const hasOps = "ops" in o;
  const problems = new Problems();
  problems.invalid.push(...invalid);
  problems.notApplied.push(...notApplied);
  const body = structuredClone(live) as V2MethodResponse;
  for (const e of edits) setAtPath(body, e.path, e.value);
  const edited = hasOps ? (structuredClone(body) as V2MethodResponse) : body;
  const lockedSteps = new Set(edits.map((e) => /^steps\[(\d+)\]/.exec(e.path)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]) + 1));
  const structural = hasOps
    ? applyStructuralOps(body, o.ops, { catalog: opts.catalog ?? emptyCatalog(), p: problems, parse: opts, lockedSteps })
    : null;
  throwProblems(problems);

  if (edits.length === 0 && !structural?.applied.length) {
    throw new CliError("Overlay contains no changes; nothing to save.", {
      code: "AD_OVERLAY_NOT_APPLIED",
      details: { notApplied: [] },
    });
  }

  // ── L0: only target leaves changed (metadata / ids untouched) ─────────
  const changed = diffPaths(live, edited);
  const drift = changed.filter((p) => !edits.some((e) => isUnder(p, e.path)));
  if (structural) drift.push(...structuralDrift(edited, body, structural));
  if (drift.length > 0) {
    throw new CliError(
      `Refusing to save: the overlay changed fields it did not target: ${drift.slice(0, 20).join(", ")}. ` +
        "This is a belz bug; the draft was not modified.",
      { code: "AD_SERIALIZER_DRIFT", details: { paths: drift } },
    );
  }

  const noEffect = edits.filter((e) => jsonEqual(getAtPath(live, e.path), e.value));
  if (structural) {
    if (jsonEqual(live, body)) {
      throw refuseNotApplied([...structural.applied, ...edits.map((e) => e.key)].map((key) => ({ key, reason: "identical to the current draft (no change)" })));
    }
  } else if (noEffect.length === edits.length) {
    throw refuseNotApplied(noEffect.map((e) => ({ key: e.key, reason: "identical to the current draft (no change)" })));
  }
  const effective = edits.filter((e) => !noEffect.includes(e));
  const plan: V2OverlayPlan = {
    body,
    targets: effective.map((e) => ({ key: e.key, path: e.path, value: e.value })),
    applied: [...effective.map((e) => e.key), ...(structural?.applied ?? [])],
    unchanged: noEffect.map((e) => e.key),
  };
  if (structural) {
    // Legacy leaf edits: a whole step (at its new position) or a top-level key is touched.
    const touched = new Set(structural.touched);
    for (const e of effective) {
      const m = /^steps\[(\d+)\]/.exec(e.path);
      if (!m) touched.add(e.path);
      else {
        const at = structural.order.indexOf(Number(m[1]) + 1);
        if (at >= 0) touched.add(`steps[${at}]`);
      }
    }
    plan.structural = { touched: [...touched], order: structural.order };
  }
  return plan;
}

/** Throw the collected problems with the most specific stable code. */
function throwProblems(p: Problems): void {
  if (p.unknown.length > 0) {
    throw new CliError(
      `Unknown overlay key(s): ${p.unknown.join(", ")}. Supported: name, summary, description; ` +
        `parsedSteps[] {${[...STEP_KEYS].join(", ")}}; ops[] {op: ${OP_NAMES.join(" | ")}}.`,
      { code: "AD_OVERLAY_UNKNOWN_KEY", details: { unknown: p.unknown } },
    );
  }
  if (p.invalid.length > 0) {
    throw new CliError(`Overlay has invalid values: ${p.invalid.map((x) => `${x.key} (${x.reason})`).join("; ")}`, {
      code: "AD_OVERLAY_INVALID",
      details: { invalid: p.invalid },
    });
  }
  if (p.notApplied.length > 0) throw refuseNotApplied(p.notApplied);
}

/**
 * L0 for ops: every step not updated/removed reads exactly as fetched (at its
 * new position), method fields not set/removed are unchanged, and nothing
 * outside steps/inputs/outputs/variables moved.
 */
function structuralDrift(
  edited: V2MethodResponse,
  body: V2MethodResponse,
  s: { order: Array<number | null>; updated: number[]; touched: string[] },
): string[] {
  const out: string[] = [];
  const lists = ["steps", "inputs", "outputs", "variables"];
  const strip = (b: V2MethodResponse) => Object.fromEntries(Object.entries(b).filter(([k]) => !lists.includes(k)));
  out.push(...diffPaths(strip(edited), strip(body)));
  const before = edited.steps ?? [];
  s.order.forEach((from, i) => {
    if (from === null || s.updated.includes(from)) return;
    if (!jsonEqual(before[from - 1], body.steps?.[i])) out.push(`steps[${i}] (fetched step ${from})`);
  });
  for (const list of ["inputs", "outputs", "variables"] as const) {
    const prev = new Map(((edited[list] ?? []) as unknown[]).filter(isObj).map((f) => [f.key, f]));
    ((body[list] ?? []) as unknown[]).forEach((f, i) => {
      if (!isObj(f) || s.touched.includes(`${list}[${i}]`)) return;
      if (!jsonEqual(prev.get(f.key), f)) out.push(`${list}[${i}]`);
    });
  }
  return out;
}

/**
 * Custom code keeps its stored encoding: base64 stays base64, plain stays
 * plain. The runtime content-sniffs, so a plain source that happens to be
 * canonical base64 is stored encoded (otherwise it would be decoded to garbage).
 */
function encodeSource(current: unknown, source: string): string {
  const wasB64 = typeof current === "string" && current.length > 0 && decodeBase64Strict(current) !== null;
  if (wasB64 || decodeBase64Strict(source) !== null) return encodeBase64(source);
  return source;
}

function setAtPath(root: unknown, path: string, value: unknown): void {
  const segs = pathSegments(path);
  let cur = root as Record<string | number, unknown>;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cur[segs[i]!];
    if (next === null || typeof next !== "object") {
      throw new CliError(`Cannot write ${path}: ${segs.slice(0, i + 1).join(".")} is not an object.`, {
        code: "AD_SERIALIZER_DRIFT",
        details: { path },
      });
    }
    cur = next as Record<string | number, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}

function refuseNotApplied(notApplied: NotAppliedEntry[]): CliError {
  return new CliError(
    `Refusing to save: ${notApplied.length} overlay key(s) would not be applied: ` +
      notApplied.map((x) => `${x.key} — ${x.reason}`).join("; "),
    { code: "AD_OVERLAY_NOT_APPLIED", details: { notApplied } },
  );
}

function checkKnownKeys(o: Record<string, unknown>): void {
  const unknown: string[] = [];
  for (const k of Object.keys(o)) if (!TOP_LEVEL_KEYS.has(k)) unknown.push(k);
  const nested = (list: unknown, name: string, allowed: Set<string>) => {
    if (!Array.isArray(list)) return;
    list.forEach((e, i) => {
      if (e && typeof e === "object" && !Array.isArray(e)) {
        for (const k of Object.keys(e)) if (!allowed.has(k)) unknown.push(`${name}[${i}].${k}`);
      }
    });
  };
  nested(o.inputs, "inputs", INPUT_KEYS);
  nested(o.parsedSteps, "parsedSteps", STEP_KEYS);
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown overlay key(s): ${unknown.join(", ")}. Supported: name, summary, description; ` +
        `parsedSteps[] {${[...STEP_KEYS].join(", ")}}; ops[] {op: ${OP_NAMES.join(" | ")}}.`,
      { code: "AD_OVERLAY_UNKNOWN_KEY", details: { unknown } },
    );
  }
}
