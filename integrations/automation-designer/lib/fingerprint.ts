// Cross-environment fingerprinting for AD methods.
//
// `belz ad trace` locates a method on the dev version-history "spine" and on
// every other environment. The fingerprint must be both:
//   - sensitive to real logic changes (CUSTOM_CODE / SQL / SPEL bodies), and
//   - INSENSITIVE to env-local identifiers.
//
// The raw wire JSON fails the second test: it carries per-env numeric IDs
// (automationId, automationApiId, automationAuthId, testAccountId, V1 input
// IDs) that differ between environments even when the logic is identical, so
// hashing `raw` makes qa look "diverged" from dev. A (orderIndex, kind,
// description) hash fails the first test — it collapses body edits.
//
// So we hash a SEMANTIC projection: step order/kind/description, the called
// service+method NAMES (stable across envs), condition expressions, the
// decoded code/SQL/expression bodies, and input mapping VALUES — everything
// substantive, nothing env-local.

import { createHash } from "crypto";
import { parseV1Method, parseV2Method } from "./parser/index";
import type { HydratedMethod, ParsedStep, StepInput } from "./types/common";
import type { MethodVersionFull } from "./api/v1";
import type { V1RawMethodResponse } from "./types/v1-wire";
import type { V2MethodResponse } from "./types/v2-wire";

/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Env-agnostic projection of a step input — mapping VALUE, not wiring IDs. */
function semanticInput(i: StepInput): unknown {
  return {
    value: i.value ?? null,
    combine: !!i.combineInput,
    ref: i.reference ?? "",
    mappings: (i.mappings ?? []).map(semanticInput),
  };
}

/** Env-agnostic projection of one step: substantive logic only. */
function semanticStep(s: ParsedStep): unknown {
  const base: Record<string, unknown> = {
    o: s.orderIndex,
    kind: s.kind,
    desc: s.description ?? "",
    svc: s.serviceName ?? "",
    mth: s.methodName ?? "",
    cond: s.conditionExpression ?? "",
    inputs: (s.inputs ?? []).map(semanticInput),
  };
  switch (s.kind) {
    case "CUSTOM_CODE": base.body = { lang: s.language, src: s.source }; break;
    case "SPEL_ECHO": base.body = { expr: s.expression }; break;
    case "SQL": base.body = { op: s.operation, sql: s.sql }; break;
    case "REDIS_GET":
    case "REDIS_SET":
    case "REDIS_REMOVE":
      base.body = { key: s.key, value: s.value, ttl: s.ttlSeconds, store: s.store, overwrite: s.overwrite };
      break;
    case "UNKNOWN": base.body = { reason: s.reason }; break;
  }
  return base;
}

/** Stable 12-hex structural fingerprint of a method's logic + input contract. */
export function fingerprintMethod(m: HydratedMethod): string {
  const steps = [...m.parsedSteps]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map(semanticStep);
  const inputs = [...m.inputs]
    .map((i) => ({ code: i.code, type: i.type, required: !!i.required }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const payload = stableStringify({ steps, inputs });
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

/**
 * Env-agnostic, human-readable view of a method for DIFFING (AD-26): the same
 * semantic step projection the fingerprint hashes (decoded code / SQL / SpEL,
 * service names, conditions, mapping values — no env-local ids), plus the
 * display fields and the full input / variable / output contract. Two envs
 * running the same logic produce identical views.
 */
export function methodDiffView(m: HydratedMethod): Record<string, unknown> {
  const field = (f: { code?: string; type?: unknown; required?: boolean; displayName?: string }) => ({
    code: f.code ?? "",
    type: f.type ?? null,
    required: !!f.required,
    displayName: f.displayName ?? "",
  });
  return {
    name: m.name,
    summary: m.summary ?? "",
    description: m.description ?? "",
    inputs: m.inputs.map(field),
    variables: m.variables.map(field),
    outputs: m.outputs.map((o) => field(o as unknown as { code?: string; type?: unknown })),
    steps: [...m.parsedSteps].sort((a, b) => a.orderIndex - b.orderIndex).map(semanticStep),
  };
}

/** JSON paths where two values differ (deep, arrays by index). Capped at `limit`. */
export function diffPaths(a: unknown, b: unknown, limit = 200, path = "$", out: string[] = []): string[] {
  if (out.length >= limit) return out;
  if (a === b) return out;
  const isObj = (v: unknown) => v !== null && typeof v === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n && out.length < limit; i++) diffPaths(a[i], b[i], limit, `${path}[${i}]`, out);
    return out;
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()) {
      if (out.length >= limit) break;
      diffPaths(ao[k], bo[k], limit, `${path}.${k}`, out);
    }
    return out;
  }
  if (stableStringify(a) !== stableStringify(b)) out.push(path);
  return out;
}

/**
 * Parse a history version's `jsonDefinition` into a HydratedMethod.
 *
 * The history.get response carries jsonDefinition as either a V1-style
 * stringified JSON (older versions) or a V2-style flat object with
 * `metadata` / `steps` / `inputs` at top level (current versions). We detect
 * the shape and dispatch to the matching parser.
 */
export function parseVersionBody(full: MethodVersionFull): HydratedMethod {
  const jd = full.jsonDefinition;

  if (jd && typeof jd === "object" && !Array.isArray(jd)) {
    const obj = jd as Record<string, unknown>;
    if (obj.metadata || obj.steps || obj.inputs) {
      return parseV2Method(obj as V2MethodResponse);
    }
    // V1 inner definition (name, services, inputs) — wrap as V1.
    const fakeRaw: V1RawMethodResponse = {
      uuid: full.methodID || "",
      referenceId: "",
      aliasName: "",
      automationState: full.isPublished ? "PUBLISHED" : "DRAFT",
      jsonDefinition: JSON.stringify(obj),
      version: full.methodVersion,
    };
    return parseV1Method(fakeRaw);
  }

  const fakeRaw: V1RawMethodResponse = {
    uuid: full.methodID || "",
    referenceId: "",
    aliasName: "",
    automationState: full.isPublished ? "PUBLISHED" : "DRAFT",
    jsonDefinition: typeof jd === "string" ? jd : "{}",
    version: full.methodVersion,
  };
  return parseV1Method(fakeRaw);
}
