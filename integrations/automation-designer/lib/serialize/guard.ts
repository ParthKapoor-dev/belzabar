// `ad save` safety guard (Stage 0.4).
//
// Wraps the V1 serializer so a save can never silently corrupt or silently
// no-op:
//
//   1. Shape check — unknown overlay keys → AD_OVERLAY_UNKNOWN_KEY; wrong
//      value types → AD_OVERLAY_INVALID.
//   2. Applicability — keys the serializer cannot write yet (name,
//      buttonLabel, internalMethod), steps that do not exist / are ambiguous,
//      and `sql`/`expression`/`source` on a step of another kind →
//      AD_OVERLAY_NOT_APPLIED (before anything is serialized).
//   3. Round-trip invariant — serialize with the overlay applied and deep-diff
//      the parsed inner definition against the fetched `jsonDefinition`.
//      Any changed path the overlay did not target → AD_SERIALIZER_DRIFT.
//   4. Effect check — every overlay key must change at least one path it
//      targets; otherwise → AD_OVERLAY_NOT_APPLIED (e.g. value identical to
//      the current one).
//
// Pure (no network). Stage 5 replaces this with the full validator on V2.

import { CliError } from "@belzabar/core";
import type { CustomCodeStep, HydratedMethod, ParsedStep, SpelEchoStep, SqlStep } from "../types/common";
import type { V1InnerDefinition, V1RawMethodResponse, V1SavePayload } from "../types/v1-wire";
import { SerializeError, findServiceIndex, serializeToV1SavePayload } from "./v1";

const TOP_LEVEL_KEYS = new Set([
  "name",
  "summary",
  "description",
  "buttonLabel",
  "internalMethod",
  "inputs",
  "parsedSteps",
]);
const INPUT_KEYS = new Set(["code", "testValue"]);
const STEP_KEYS = new Set(["orderIndex", "source", "sql", "expression", "description"]);

/** Keys the V1 serializer does not write yet. Refused rather than dropped. */
const UNWRITABLE_TOP_LEVEL = new Set(["name", "buttonLabel", "internalMethod"]);

const STEP_FIELD_KIND: Record<string, ParsedStep["kind"]> = {
  source: "CUSTOM_CODE",
  sql: "SQL",
  expression: "SPEL_ECHO",
};

export interface NotAppliedEntry {
  key: string;
  reason: string;
}

export interface GuardedSaveResult {
  payload: V1SavePayload;
  /** Overlay keys (as paths) that were verified to change the payload. */
  applied: string[];
  /** Overlay keys whose value already matched the draft (warned, not refused). */
  unchanged: string[];
}

export interface GuardedSaveOptions {
  version?: number;
  warn?: (msg: string) => void;
}

interface PlannedEdit {
  /** Overlay key path for reporting, e.g. `parsedSteps[orderIndex=2].source`. */
  key: string;
  /** Wire paths (inner definition) this edit may change. */
  allowed: string[];
  apply: () => void;
}

/**
 * Apply `overlay` to `method` and build a V1 save payload, enforcing the
 * guard described above. Throws CliError with a stable code on any refusal.
 * Mutates `method` (the overlay is applied in place).
 */
export function buildGuardedV1SavePayload(
  method: HydratedMethod,
  overlay: unknown,
  opts: GuardedSaveOptions = {},
): GuardedSaveResult {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
    throw new CliError("Overlay must be a JSON object.", { code: "AD_OVERLAY_INVALID" });
  }
  const o = overlay as Record<string, unknown>;

  checkKnownKeys(o);

  const raw = method.raw as V1RawMethodResponse;
  let before: V1InnerDefinition;
  try {
    before = JSON.parse(raw.jsonDefinition) as V1InnerDefinition;
  } catch (err) {
    throw new CliError(`Fetched jsonDefinition does not parse: ${String(err)}`, { code: "AD_SERIALIZE_FAILED" });
  }
  const services = Array.isArray(before.services) ? before.services : [];
  const inputs = Array.isArray(before.inputs) ? before.inputs : [];

  const edits: PlannedEdit[] = [];
  const notApplied: NotAppliedEntry[] = [];
  const invalid: NotAppliedEntry[] = [];
  const methodPatch: { summary?: string; methodDescription?: string } = {};

  // ── method-level keys ─────────────────────────────────────────────────
  for (const key of UNWRITABLE_TOP_LEVEL) {
    if (key in o) notApplied.push({ key, reason: "not writable by `ad save` yet (the V1 serializer does not persist it)" });
  }
  if ("summary" in o) {
    if (typeof o.summary !== "string") invalid.push({ key: "summary", reason: "must be a string" });
    else {
      const v = o.summary;
      edits.push({ key: "summary", allowed: ["summary"], apply: () => { methodPatch.summary = v; } });
    }
  }
  if ("description" in o) {
    if (typeof o.description !== "string") invalid.push({ key: "description", reason: "must be a string" });
    else {
      const v = o.description;
      edits.push({
        key: "description",
        allowed: ["methodDescription"],
        apply: () => { methodPatch.methodDescription = v; },
      });
    }
  }

  // ── inputs[].testValue ────────────────────────────────────────────────
  if ("inputs" in o) {
    if (!Array.isArray(o.inputs)) invalid.push({ key: "inputs", reason: "must be an array" });
    else {
      o.inputs.forEach((entry, i) => {
        const where = `inputs[${i}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          invalid.push({ key: where, reason: "must be an object {code, testValue}" });
          return;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.code !== "string") {
          invalid.push({ key: `${where}.code`, reason: "must be a string" });
          return;
        }
        const code = e.code;
        if (!("testValue" in e)) {
          notApplied.push({ key: `inputs[code=${code}]`, reason: "no writable field (only testValue is supported)" });
          return;
        }
        const wireIdx = inputs.findIndex(f => f.fieldCode === code);
        const field = method.inputs.find(f => f.code === code);
        if (wireIdx === -1 || !field) {
          notApplied.push({ key: `inputs[code=${code}].testValue`, reason: `no input with fieldCode '${code}'` });
          return;
        }
        edits.push({
          key: `inputs[code=${code}].testValue`,
          allowed: [`inputs[${wireIdx}].testValue`],
          apply: () => { field.testValue = e.testValue; },
        });
      });
    }
  }

  // ── parsedSteps[] ─────────────────────────────────────────────────────
  if ("parsedSteps" in o) {
    if (!Array.isArray(o.parsedSteps)) invalid.push({ key: "parsedSteps", reason: "must be an array" });
    else {
      o.parsedSteps.forEach((entry, i) => {
        const where = `parsedSteps[${i}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          invalid.push({ key: where, reason: "must be an object with orderIndex" });
          return;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.orderIndex !== "number") {
          invalid.push({ key: `${where}.orderIndex`, reason: "must be a number" });
          return;
        }
        const idx = e.orderIndex;
        const fields = Object.keys(e).filter(k => k !== "orderIndex");
        const label = (f: string) => `parsedSteps[orderIndex=${idx}].${f}`;
        for (const f of fields) {
          if (typeof e[f] !== "string") invalid.push({ key: label(f), reason: "must be a string" });
        }
        const matches = method.parsedSteps.filter(s => s.orderIndex === idx);
        if (matches.length === 0) {
          for (const f of fields) notApplied.push({ key: label(f), reason: `no step with orderIndex ${idx}` });
          return;
        }
        if (matches.length > 1) {
          for (const f of fields) {
            notApplied.push({ key: label(f), reason: `orderIndex ${idx} is ambiguous (${matches.length} steps share it)` });
          }
          return;
        }
        const step = matches[0]!;
        const svcIdx = findServiceIndex(services, step);
        if (svcIdx === -1) {
          for (const f of fields) notApplied.push({ key: label(f), reason: `step ${idx} not found in jsonDefinition.services` });
          return;
        }
        const svc = `services[${svcIdx}]`;
        for (const f of fields) {
          const value = e[f];
          if (typeof value !== "string") continue;
          if (f === "description") {
            edits.push({ key: label(f), allowed: [`${svc}.description`], apply: () => { step.description = value; } });
            continue;
          }
          const needKind = STEP_FIELD_KIND[f]!;
          if (step.kind !== needKind) {
            notApplied.push({
              key: label(f),
              reason: `step ${idx} is classified as ${step.kind}, not ${needKind}; '${f}' cannot be written to it`,
            });
            continue;
          }
          if (f === "source") {
            edits.push({ key: label(f), allowed: [`${svc}.code`], apply: () => { (step as CustomCodeStep).source = value; } });
          } else if (f === "sql") {
            edits.push({ key: label(f), allowed: [`${svc}.mappings`], apply: () => { (step as SqlStep).sql = value; } });
          } else {
            edits.push({
              key: label(f),
              allowed: [`${svc}.mappings[0].value`],
              apply: () => { (step as SpelEchoStep).expression = value; },
            });
          }
        }
      });
    }
  }

  if (invalid.length > 0) {
    throw new CliError(
      `Overlay has invalid values: ${invalid.map(x => `${x.key} (${x.reason})`).join("; ")}`,
      { code: "AD_OVERLAY_INVALID", details: { invalid } },
    );
  }
  if (notApplied.length > 0) {
    throw refuseNotApplied(notApplied);
  }
  if (edits.length === 0) {
    throw new CliError("Overlay contains no changes; nothing to save.", {
      code: "AD_OVERLAY_NOT_APPLIED",
      details: { notApplied: [] },
    });
  }

  // ── apply + serialize ─────────────────────────────────────────────────
  for (const edit of edits) edit.apply();
  if (edits.some(e => e.key.startsWith("inputs["))) {
    opts.warn?.("inputs[].testValue is sent, but the server is known to drop stored testValues on save.");
  }

  let payload: V1SavePayload;
  try {
    payload = serializeToV1SavePayload(method, { version: opts.version, methodPatch, warn: opts.warn });
  } catch (err) {
    if (err instanceof SerializeError) {
      throw new CliError(err.message, {
        code: "AD_SERIALIZE_FAILED",
        details: { stepOrderIndex: err.stepOrderIndex },
      });
    }
    throw err;
  }

  // ── transport invariants ──────────────────────────────────────────────
  const transportDrift: string[] = [];
  if (raw.category && payload.category.id !== raw.category.id) transportDrift.push("category.id");
  if (typeof raw.id === "number" && payload.id !== raw.id) transportDrift.push("id");
  if (typeof raw.uuid === "string" && payload.uuid !== raw.uuid) transportDrift.push("uuid");

  // ── round-trip invariant + effect check ───────────────────────────────
  const after = JSON.parse(payload.jsonDefinition) as unknown;
  const changed = diffPaths(before, after);
  const allAllowed = edits.flatMap(e => e.allowed);
  const drift = changed.filter(p => !allAllowed.some(a => isUnder(p, a)));
  if (drift.length > 0 || transportDrift.length > 0) {
    const paths = [...transportDrift, ...drift];
    throw new CliError(
      `Refusing to save: the serializer changed fields the overlay did not target: ${paths.slice(0, 20).join(", ")}` +
        (paths.length > 20 ? ` (+${paths.length - 20} more)` : "") +
        ". This is a belz bug; the draft was not modified.",
      { code: "AD_SERIALIZER_DRIFT", details: { paths } },
    );
  }

  // Keys whose value already matches the draft are harmless when other keys
  // change something; only an overlay that changes nothing at all is refused.
  const noEffect = edits.filter(e => !changed.some(p => e.allowed.some(a => isUnder(p, a))));
  if (noEffect.length === edits.length) {
    throw refuseNotApplied(
      noEffect.map(e => ({ key: e.key, reason: "produces no change (value identical to the current one?)" })),
    );
  }
  for (const e of noEffect) opts.warn?.(`Overlay key ${e.key} is identical to the current draft; nothing to change.`);

  return {
    payload,
    applied: edits.filter(e => !noEffect.includes(e)).map(e => e.key),
    unchanged: noEffect.map(e => e.key),
  };
}

function refuseNotApplied(notApplied: NotAppliedEntry[]): CliError {
  return new CliError(
    `Refusing to save: ${notApplied.length} overlay key(s) would not be applied: ` +
      notApplied.map(x => `${x.key} — ${x.reason}`).join("; "),
    { code: "AD_OVERLAY_NOT_APPLIED", details: { notApplied } },
  );
}

function checkKnownKeys(o: Record<string, unknown>): void {
  const unknown: string[] = [];
  for (const k of Object.keys(o)) if (!TOP_LEVEL_KEYS.has(k)) unknown.push(k);
  if (Array.isArray(o.inputs)) {
    o.inputs.forEach((e, i) => {
      if (e && typeof e === "object" && !Array.isArray(e)) {
        for (const k of Object.keys(e)) if (!INPUT_KEYS.has(k)) unknown.push(`inputs[${i}].${k}`);
      }
    });
  }
  if (Array.isArray(o.parsedSteps)) {
    o.parsedSteps.forEach((e, i) => {
      if (e && typeof e === "object" && !Array.isArray(e)) {
        for (const k of Object.keys(e)) if (!STEP_KEYS.has(k)) unknown.push(`parsedSteps[${i}].${k}`);
      }
    });
  }
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown overlay key(s): ${unknown.join(", ")}. Supported: ${[...TOP_LEVEL_KEYS].join(", ")}; ` +
        `inputs[] {${[...INPUT_KEYS].join(", ")}}; parsedSteps[] {${[...STEP_KEYS].join(", ")}}.`,
      { code: "AD_OVERLAY_UNKNOWN_KEY", details: { unknown } },
    );
  }
}

/** `p` equals `prefix` or lies below it (`prefix.x` / `prefix[i]`). */
function isUnder(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`);
}

/**
 * Deep-diff two parsed JSON values and return the paths of every differing
 * leaf (or of a subtree that was added/removed/changed type). Object key
 * order is ignored; array order is significant.
 */
export function diffPaths(a: unknown, b: unknown, path = ""): string[] {
  if (a === b) return [];
  const aObj = a !== null && typeof a === "object";
  const bObj = b !== null && typeof b === "object";
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) return [path || "$"];
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length || i >= b.length) out.push(p);
      else out.push(...diffPaths(a[i], b[i], p));
    }
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const out: string[] = [];
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in ao) || !(k in bo)) out.push(p);
    else out.push(...diffPaths(ao[k], bo[k], p));
  }
  return out;
}
