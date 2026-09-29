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
// So we hash the wire body minus server bookkeeping and env-local ids (see
// `fingerprintProjection`, ADW-R2). Methods without a wire body fall back to
// a SEMANTIC step projection: step order/kind/description, the called
// service+method NAMES, condition expressions, the decoded code/SQL/expression
// bodies, and input mapping VALUES.

import { createHash } from "crypto";
import { parseV1Method, parseV2Method } from "./parser/index";
import { decodeBase64Strict } from "./base64";
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

// ─── Wire projection (ADW-R2) ────────────────────────────────────────────
//
// The hydrated model is lossy: it has no step-output fieldCode /
// elementToRetrieve, no conditional exit, no account name, … so a
// fingerprint built from it called a draft whose only change was an output
// binding, a loop, an exit rule or the DB account "in sync" with production.
// When the wire body is available we therefore hash the WHOLE body minus a
// deny-list of server bookkeeping and env-local ids. That is fail-safe: a
// field nobody listed still changes the fingerprint.

/**
 * Keys dropped wherever they appear: row / wiring ids (env-local, and step
 * ids differ between a draft and its published copy), state, versions,
 * audit stamps, the change log, the test suite, the viewer's permissions.
 */
export const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  "id",
  "uuid",
  "automationApiId",
  "automationAPIId",
  "automationId",
  "automationAuthId",
  "testAccountId",
  "automationUserInputId",
  "automationUserInputUuid",
  "automationAPIOutputId",
  "automationAPIOutputUuid",
  "chainId",
  "testSuiteId",
  "testCaseId",
  "referenceId",
  "automationState",
  "state",
  "version",
  "changelogs",
  "testSuite",
  "permissions",
  "migration",
  "createdOn",
  "createdAt",
  "createdBy",
  "updatedOn",
  "updatedBy",
  "lastUpdatedOn",
  "lastUpdatedBy",
  "lastPublishedAt",
  "lastPublishedBy",
  "addedBy",
  "addedWhen",
]);

/**
 * A key whose value never identifies a finding or a removal: one of
 * BOOKKEEPING_KEYS, or any other id / uuid field (`…Id(s)`, `…Uuid(s)`).
 * Used by the validator's finding identity and the post-save removal check.
 * The fingerprint is stricter (see `projectIdField`): a uuid can name WHICH
 * API / method a step calls, so it stays in the hash, normalised.
 */
export function isBookkeepingKey(k: string): boolean {
  return BOOKKEEPING_KEYS.has(k) || /(Id|Uuid)s?$/.test(k);
}

const NUMERIC_ID = /^\s*\d+\s*$/;
/** Canonical uuid spelling: space padding, case and dashes differ between copies (live: padded after a restore). */
function normaliseUuid(v: string): string {
  return v.trim().toLowerCase().replace(/-/g, "");
}

/**
 * An `…Id(s)` / `…Uuid(s)` field outside BOOKKEEPING_KEYS, for the fingerprint:
 * env-local NUMERIC ids are dropped (undefined); anything else (a V1
 * automationApiUuid naming the called API, a child-method uuid) is kept,
 * normalised, so re-binding a step to another callee changes the hash.
 */
function projectIdField(v: unknown): unknown {
  if (typeof v === "number" || (typeof v === "string" && NUMERIC_ID.test(v))) return undefined;
  if (typeof v === "string") return normaliseUuid(v);
  if (Array.isArray(v)) {
    const kept = v.map(projectIdField).filter((x) => x !== undefined);
    return kept.length > 0 ? kept : undefined;
  }
  return projectWire(v);
}

/** The body to project: the V2 object, or V1's parsed jsonDefinition. */
function wireBody(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.steps)) return obj;
  if (typeof obj.jsonDefinition === "string") {
    try {
      const jd = JSON.parse(obj.jsonDefinition) as unknown;
      return jd && typeof jd === "object" && !Array.isArray(jd) ? (jd as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  if (obj.jsonDefinition && typeof obj.jsonDefinition === "object") return wireBody(obj.jsonDefinition);
  return undefined;
}

/** A stored base64 body and the same body in plain text behave the same. */
function decoded(v: unknown): unknown {
  return typeof v === "string" ? (decodeBase64Strict(v) ?? v) : v;
}

function projectWire(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(projectWire);
  if (typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (BOOKKEEPING_KEYS.has(k)) continue;
    if (/(Id|Uuid)s?$/.test(k)) {
      const pv = projectIdField(v);
      if (pv !== undefined) out[k] = pv;
      continue;
    }
    if (k === "metadata") {
      // Only the behavioural parts: where the method lives and its time limit.
      const md = (v ?? {}) as Record<string, unknown>;
      const svc = md.service as Record<string, unknown> | undefined;
      const projected = projectWire({ service: svc?.name, executionTimeLimit: md.executionTimeLimit, categories: md.categories });
      if (projected && Object.keys(projected as object).length > 0) out.metadata = projected;
      continue;
    }
    let pv: unknown;
    if (k === "inlineCode" || k === "code") pv = decoded(v);
    else if (k === "value" && obj.encodingType === "BASE_64") pv = decoded(v);
    else if (k === "encodingType" && v === "BASE_64" && typeof obj.value === "string" && decodeBase64Strict(obj.value) !== null) pv = "NONE";
    else pv = projectWire(v);
    if (pv !== undefined) out[k] = pv;
  }
  // V1 services carry their position in orderIndex, not array order.
  return out;
}

function orderedV1(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.services)) return body;
  const services = [...(body.services as Array<Record<string, unknown>>)].sort(
    (a, b) => Number(a?.orderIndex ?? 0) - Number(b?.orderIndex ?? 0),
  );
  return { ...body, services };
}

/**
 * The exact projection `fingerprintMethod` hashes when the wire body is
 * available (exported for tests and diagnostics); `undefined` otherwise.
 */
export function fingerprintProjection(m: HydratedMethod): unknown {
  const body = wireBody(m.raw);
  return body ? projectWire(orderedV1(body)) : undefined;
}

/**
 * Stable 12-hex fingerprint of everything that changes a method's behaviour.
 *
 * With the wire body (every fetched / history-parsed method): the whole body
 * minus bookkeeping (BOOKKEEPING_KEYS, numeric …Ids; other …Uuids normalised) — steps' inputs, outputs, SQL,
 * code, service, account (by name), conditions, exit, loop, async, and the
 * method's inputs, outputs, variables and display fields. A draft and its
 * published copy of the same content match. Without a body (hand-built
 * methods) it falls back to the hydrated step projection.
 *
 * Compare fingerprints of V2 (or history) bodies. V1 jsonDefinitions carry UI
 * serialisation noise that differs between a UI-saved draft and its
 * server-built published copy (activeTab text, automationUiSelector,
 * executionStatus, orderIndex -1 defaults — live sems-dev), and have no
 * account name; `ad state` / `ad publish` therefore read both sides on V2.
 */
export function fingerprintMethod(m: HydratedMethod): string {
  const projection = fingerprintProjection(m);
  if (projection !== undefined) {
    return createHash("sha256").update(stableStringify(projection)).digest("hex").slice(0, 12);
  }
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
