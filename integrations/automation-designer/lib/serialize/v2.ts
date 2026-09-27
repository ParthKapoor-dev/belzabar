// `ad save` overlay → V2 save body (Stage 5, D1: the save route is
// `GET /chain/v2/{uuid}` → overlay → `POST /chain/v2`).
//
// The body sent is the live V2 GET body with ONLY the overlay's target leaves
// replaced. Everything else — metadata (state, version, service, internal),
// step ids, padded uuids, changelogs, permissions — is passed back verbatim,
// which is what the server's "Invalid state, provided state does not match"
// check requires. Custom code is written in the step's stored encoding; SQL in
// its slot's `encodingType`.
//
// Guarantees (carried over from the Stage-0 V1 guard):
//   1. Unknown overlay keys → AD_OVERLAY_UNKNOWN_KEY; bad value types →
//      AD_OVERLAY_INVALID.
//   2. Keys that cannot land → AD_OVERLAY_NOT_APPLIED: missing/ambiguous step,
//      a field on a step of another kind, and fields the V2 route silently
//      drops (buttonLabel, internalMethod, inputs[].testValue — live sems-dev
//      2026-09-28: 200 OK, absent from the next GET and from V1).
//   3. L0: the body differs from the live body only at target paths
//      (AD_SERIALIZER_DRIFT otherwise) — metadata can never change.
//   4. Effect: an overlay that changes nothing → AD_OVERLAY_NOT_APPLIED; a
//      single no-op key next to real changes is reported in `unchanged`.
//
// Pure: no network.

import { CliError } from "@belzabar/core";
import type { V2MethodResponse, V2Step, V2StepInput } from "../types/v2-wire";
import { decodeBase64Strict, encodeBase64 } from "../base64";
import { parseV2Step } from "../parser/steps/v2";
import type { ParseOptions } from "../parser/steps/classify";
import { diffPaths, getAtPath, isUnder, jsonEqual, pathSegments } from "./diff";

const TOP_LEVEL_KEYS = new Set(["name", "summary", "description", "buttonLabel", "internalMethod", "inputs", "parsedSteps"]);
const INPUT_KEYS = new Set(["code", "testValue"]);
const STEP_KEYS = new Set(["orderIndex", "source", "sql", "expression", "description"]);

/** Fields the V2 save route accepts with 200 and then drops (verified live). */
const DROPPED_BY_V2 = new Set(["buttonLabel", "internalMethod"]);

export interface NotAppliedEntry {
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
export function planV2Overlay(live: V2MethodResponse, overlay: unknown, opts: ParseOptions = {}): V2OverlayPlan {
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

  if (invalid.length > 0) {
    throw new CliError(`Overlay has invalid values: ${invalid.map((x) => `${x.key} (${x.reason})`).join("; ")}`, {
      code: "AD_OVERLAY_INVALID",
      details: { invalid },
    });
  }
  if (notApplied.length > 0) throw refuseNotApplied(notApplied);
  if (edits.length === 0) {
    throw new CliError("Overlay contains no changes; nothing to save.", {
      code: "AD_OVERLAY_NOT_APPLIED",
      details: { notApplied: [] },
    });
  }

  // ── apply onto a deep copy ────────────────────────────────────────────
  const body = structuredClone(live) as V2MethodResponse;
  for (const e of edits) setAtPath(body, e.path, e.value);

  // ── L0: only target leaves changed (metadata / ids untouched) ─────────
  const changed = diffPaths(live, body);
  const drift = changed.filter((p) => !edits.some((e) => isUnder(p, e.path)));
  if (drift.length > 0) {
    throw new CliError(
      `Refusing to save: the overlay changed fields it did not target: ${drift.slice(0, 20).join(", ")}. ` +
        "This is a belz bug; the draft was not modified.",
      { code: "AD_SERIALIZER_DRIFT", details: { paths: drift } },
    );
  }

  const noEffect = edits.filter((e) => jsonEqual(getAtPath(live, e.path), e.value));
  if (noEffect.length === edits.length) {
    throw refuseNotApplied(noEffect.map((e) => ({ key: e.key, reason: "identical to the current draft (no change)" })));
  }
  const effective = edits.filter((e) => !noEffect.includes(e));
  return {
    body,
    targets: effective.map((e) => ({ key: e.key, path: e.path, value: e.value })),
    applied: effective.map((e) => e.key),
    unchanged: noEffect.map((e) => e.key),
  };
}

/**
 * Custom code keeps its stored encoding: base64 stays base64, plain stays
 * plain. The runtime content-sniffs, so a plain source that happens to be
 * canonical base64 is stored encoded (otherwise it would be decoded to garbage).
 */
export function encodeSource(current: unknown, source: string): string {
  const wasB64 = typeof current === "string" && current.length > 0 && decodeBase64Strict(current) !== null;
  if (wasB64 || decodeBase64Strict(source) !== null) return encodeBase64(source);
  return source;
}

/**
 * SQL encoding is flag-driven (`encodingType`): BASE_64 slots holding base64
 * get base64; everything else stays plain (a BASE_64 flag on a plain value is
 * ignored by the runtime, so plain stays plain there too).
 */
export function encodeSql(slot: V2StepInput, sql: string): string {
  const v = slot.value;
  const storedB64 = slot.encodingType === "BASE_64" && (typeof v !== "string" || v.length === 0 || decodeBase64Strict(v) !== null);
  return storedB64 ? encodeBase64(sql) : sql;
}

/** Same slot the parser reads (`body.queryString`, else the first BASE_64 string input), with its path. */
function findSqlSlot(inputs: unknown, path: string): { input: V2StepInput; path: string } | null {
  return (
    findInput(inputs, path, (i) => i.key === "queryString" && typeof i.value === "string") ??
    findInput(inputs, path, (i) => i.encodingType === "BASE_64" && typeof i.value === "string")
  );
}

function findInput(
  inputs: unknown,
  path: string,
  pred: (i: V2StepInput) => boolean,
): { input: V2StepInput; path: string } | null {
  if (!Array.isArray(inputs)) return null;
  for (let k = 0; k < inputs.length; k++) {
    const raw = inputs[k];
    if (!raw || typeof raw !== "object") continue;
    const i = raw as V2StepInput;
    const p = `${path}[${k}]`;
    if (pred(i)) return { input: i, path: p };
    const nested = findInput(i.properties, `${p}.properties`, pred);
    if (nested) return nested;
  }
  return null;
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
        `parsedSteps[] {${[...STEP_KEYS].join(", ")}}.`,
      { code: "AD_OVERLAY_UNKNOWN_KEY", details: { unknown } },
    );
  }
}
