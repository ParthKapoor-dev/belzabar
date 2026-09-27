// Serialize a HydratedMethod back into a V1 save payload.
//
// The strategy is "prefer raw, patch narrow fields":
//   1. Start from method.raw (the full V1 RawMethodResponse belz most recently
//      fetched). This guarantees fields belz doesn't model are round-tripped.
//   2. JSON.parse the inner `jsonDefinition` — it is a string on the wire.
//   3. Patch inputs.testValue from method.inputs[i].testValue (the collector
//      feeds user input here).
//   4. For each parsed step, compare its (possibly overlay-edited) body with
//      what the parser would decode from the stored wire value. Only steps
//      whose body actually changed are rewritten, and always in the step's
//      ORIGINAL encoding (plain stays plain, base64 stays base64). Unedited
//      steps stay byte-identical — re-encoding everything corrupted plain-text
//      custom code (AD-22, belz-save-corruption).
//   5. Enforce the custom-code multi-output invariant (every output needs
//      `elementToRetrieve`) on EDITED custom-code steps only; pre-existing
//      violations on untouched steps are reported through `opts.warn` (AD-21).
//   6. Stringify `jsonDefinition` and assemble the save payload with category,
//      id, uuid, and version.
//
// This file is the only place outside the parser that knows about V1's
// double-serialization. Callers never JSON.stringify the inner definition by
// hand.

import type { HydratedMethod, CustomCodeStep, SqlStep, SpelEchoStep } from "../types/common";
import type {
  V1InnerDefinition,
  V1InputField,
  V1Mapping,
  V1RawMethodResponse,
  V1SavePayload,
  V1ServiceStep,
} from "../types/v1-wire";
import { decodeBase64Strict, encodeBase64 } from "../base64";
import { decodeCustomCode, locateSqlMapping } from "../parser/steps/v1";

export class SerializeError extends Error {
  constructor(message: string, public readonly stepOrderIndex?: number) {
    super(message);
    this.name = "SerializeError";
  }
}

export interface V1SerializeOptions {
  /**
   * When set, override the version number in the outgoing payload. Normally
   * the caller bumps version by 1 for updates.
   */
  version?: number;
  /**
   * When `true`, omit the `id` and `uuid` fields so the server creates a new
   * chain instead of updating the existing one. Used by `belz ad save --new`.
   */
  forCreate?: boolean;
  /** Method-level metadata to write onto the inner definition. */
  methodPatch?: { summary?: string; methodDescription?: string };
  /** Receives non-blocking findings (e.g. pre-existing invariant violations). */
  warn?: (msg: string) => void;
}

export function serializeToV1SavePayload(
  method: HydratedMethod,
  opts: V1SerializeOptions = {},
): V1SavePayload {
  if (method.sourceVersion !== "v1") {
    // We could V2→V1 convert here, but that is future work and outside the
    // current phase. Reject clearly so callers know.
    throw new SerializeError(
      `serializeToV1SavePayload requires a method parsed via V1 (got sourceVersion=${method.sourceVersion}). ` +
        "V2→V1 conversion is not yet implemented.",
    );
  }

  const rawResponse = method.raw as V1RawMethodResponse;
  if (!rawResponse || typeof rawResponse !== "object") {
    throw new SerializeError("HydratedMethod.raw is missing or not an object — cannot round-trip");
  }

  // Round-trip the inner definition verbatim as the starting point.
  let inner: V1InnerDefinition;
  try {
    inner = JSON.parse(rawResponse.jsonDefinition) as V1InnerDefinition;
  } catch (err) {
    throw new SerializeError(`Failed to parse source jsonDefinition: ${String(err)}`);
  }

  // Patch testValue onto each input from MethodField.testValue.
  if (Array.isArray(inner.inputs)) {
    const byCode = new Map<string, V1InputField>();
    for (const f of inner.inputs) byCode.set(f.fieldCode, f);
    for (const mf of method.inputs) {
      const src = byCode.get(mf.code);
      if (src && mf.testValue !== undefined) {
        src.testValue = mf.testValue;
      }
    }
  }

  // Optional method-level metadata patches (only written when provided).
  if (opts.methodPatch?.summary !== undefined) inner.summary = opts.methodPatch.summary;
  if (opts.methodPatch?.methodDescription !== undefined) {
    inner.methodDescription = opts.methodPatch.methodDescription;
  }

  // Locate each parsed step's slot in inner.services[] (by orderIndex, then
  // automationId — we re-parsed `inner`, so object identity is gone) and
  // patch only what changed.
  if (Array.isArray(inner.services)) {
    for (const step of method.parsedSteps) {
      const idx = findServiceIndex(inner.services, step);
      if (idx === -1) continue;
      const target = inner.services[idx]!;

      if (typeof step.description === "string" && step.description !== target.description) {
        target.description = step.description;
      }

      if (step.kind === "CUSTOM_CODE") {
        const stored = typeof target.code === "string" ? target.code : "";
        const original = decodeCustomCode(stored);
        const edited = step.source !== original.source;
        enforceCustomCodeMultiOutputInvariant(step, edited, opts.warn);
        if (edited) target.code = encodeCustomCode(step.source, original.encoding);
      }

      if (step.kind === "SQL") {
        const sqlStep = step as SqlStep;
        // Same slot the parser read (AD-02: sems keeps the query beside other CUSTOM leaves).
        const loc = locateSqlMapping(target.mappings, { inputUuids: sqlStep.sqlInputUuid ? [sqlStep.sqlInputUuid] : [] });
        const originalSql = loc?.sql ?? "";
        if (sqlStep.sql !== originalSql) {
          if (!loc) {
            throw new SerializeError(
              `SQL step ${step.orderIndex}: cannot locate the query mapping (no BASE_64 slot and no unique ` +
                "CUSTOM leaf). Refusing to guess where the SQL goes.",
              step.orderIndex,
            );
          }
          if (loc.encoding === "BASE_64") {
            loc.mapping.value = encodeBase64(sqlStep.sql);
          } else {
            loc.mapping.value = sqlStep.sql;
          }
        }
      }

      if (step.kind === "SPEL_ECHO") {
        const echoStep = step as SpelEchoStep;
        const first = Array.isArray(target.mappings) ? target.mappings[0] : undefined;
        if (echoStep.expression != null && first && first.value !== echoStep.expression) {
          first.value = echoStep.expression;
        }
      }
    }
  }

  if (!rawResponse.category) {
    throw new SerializeError("Source response has no category — cannot build save payload");
  }

  const payload: V1SavePayload = {
    jsonDefinition: JSON.stringify(inner),
    category: { id: rawResponse.category.id, name: rawResponse.category.name },
    methodDeprecated: false,
    version: opts.version ?? rawResponse.version ?? method.version ?? 1,
  };

  if (!opts.forCreate) {
    if (typeof rawResponse.id === "number") payload.id = rawResponse.id;
    if (typeof rawResponse.uuid === "string") payload.uuid = rawResponse.uuid;
  }

  return payload;
}

/**
 * Index of the wire service that corresponds to a parsed step: first by
 * orderIndex, then by automationId. Exported so the save guard computes the
 * same "which paths may change" set the serializer writes to.
 */
export function findServiceIndex(
  services: V1ServiceStep[],
  step: { orderIndex: number; automationId?: string | number },
): number {
  const byOrder = services.findIndex(s => s.orderIndex === step.orderIndex);
  if (byOrder !== -1) return byOrder;
  if (step.automationId == null) return -1;
  return services.findIndex(s => s.automationId === step.automationId);
}

/**
 * Encode custom-code source in the step's original storage encoding. Plain
 * text stays plain — unless the new text happens to be strict base64, in
 * which case the runtime's content-sniffing would decode it, so we store it
 * base64-encoded instead (which the sniffing decodes back to the text).
 */
export function encodeCustomCode(source: string, encoding: "BASE_64" | "NONE"): string {
  if (encoding === "BASE_64") return encodeBase64(source);
  return decodeBase64Strict(source) !== null ? encodeBase64(source) : source;
}

/**
 * The multi-output invariant: when a CUSTOM_CODE step has more than one
 * output, EVERY output (including the first) must set `elementToRetrieve`, or
 * the server silently drops data. Enforced (throws) only on edited steps;
 * a pre-existing violation on an untouched step is reported via `warn` so an
 * unrelated save is not blocked (AD-21).
 */
function enforceCustomCodeMultiOutputInvariant(
  step: CustomCodeStep,
  edited: boolean,
  warn?: (msg: string) => void,
): void {
  const outputs = step.outputs ?? [];
  if (outputs.length <= 1) return;

  const missing: string[] = [];
  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i]!;
    const raw = (out.raw ?? {}) as Record<string, unknown>;
    const explicit = typeof raw.elementToRetrieve === "string" && (raw.elementToRetrieve as string).length > 0;
    if (!explicit) missing.push(out.code);
  }

  if (missing.length === 0) return;

  const detail =
    `CUSTOM_CODE step ${step.orderIndex} has ${outputs.length} outputs but ${missing.length} are missing ` +
    `an explicit 'elementToRetrieve': ${missing.join(", ")}.`;
  if (!edited) {
    warn?.(`${detail} (pre-existing; step not edited, saving anyway)`);
    return;
  }
  throw new SerializeError(
    `${detail} When a custom-code step has multiple outputs, every output MUST set elementToRetrieve or the ` +
      `server will silently drop data. See ad-rest-api-step-types.md §"CRITICAL: For multiple outputs".`,
    step.orderIndex,
  );
}
