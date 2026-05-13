// Serialize a HydratedMethod back into a V1 save payload.
//
// The strategy is "prefer raw, patch narrow fields":
//   1. Start from method.raw (the full V1 RawMethodResponse belz most recently
//      fetched). This guarantees fields belz doesn't model are round-tripped.
//   2. JSON.parse the inner `jsonDefinition` — it is a string on the wire.
//   3. Patch inputs.testValue from method.inputs[i].testValue (the collector
//      feeds user input here).
//   4. For parsedSteps that are CUSTOM_CODE and have been edited, re-encode
//      the source back to base64 and write it into the matching service slot.
//      Unedited steps are left alone (the `step.raw` reference is identical
//      to `innerDef.services[i]`).
//   5. Enforce the custom-code multi-output invariant: every output beyond
//      the first must have `elementToRetrieve` set, per
//      ad-rest-api-step-types.md §"CRITICAL: For multiple outputs".
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
import { encodeBase64 } from "../base64";

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

  // Validate + optionally rewrite step bodies. We locate each parsed step's
  // corresponding slot in inner.services[] by orderIndex and patch the
  // wire-level fields. We cannot match by object identity because we
  // re-parsed `inner` from the raw JSON string.
  if (Array.isArray(inner.services)) {
    for (const step of method.parsedSteps) {
      const target =
        inner.services.find(s => s.orderIndex === step.orderIndex) ??
        inner.services.find(s => step.automationId != null && s.automationId === step.automationId);
      if (!target) continue;

      // CUSTOM_CODE — re-encode source to base64
      if (step.kind === "CUSTOM_CODE") {
        enforceCustomCodeMultiOutputInvariant(step);
        const encoded = encodeBase64(step.source);
        if (target.code !== encoded) {
          target.code = encoded;
        }
        if (step.language) target.language = step.language;
        if (step.customCodeEnv) target.customCodeEnv = step.customCodeEnv;
      }

      // SQL — re-encode sql body to base64 inside the nested mappings tree.
      // The SQL value lives in the first mapping in the tree whose
      // encodingType === "BASE_64". This mirrors the decode path in
      // lib/parser/steps/v1.ts:buildSql.
      if (step.kind === "SQL") {
        const sqlStep = step as SqlStep;
        const newB64 = encodeBase64(sqlStep.sql);
        const replaced = rewriteBase64MappingValue(target.mappings, newB64);
        if (!replaced && sqlStep.sql.length > 0) {
          // Fallback: if there's no base64 mapping (unusual), try to write
          // the SQL as-is into the first mapping's value. This handles the
          // edge case of a method imported with inline (non-base64) SQL.
          if (Array.isArray(target.mappings)) {
            const first = findFirstLeafMapping(target.mappings);
            if (first) first.value = newB64;
          }
        }
      }

      // SPEL_ECHO — patch the expression into the first mapping's value.
      if (step.kind === "SPEL_ECHO") {
        const echoStep = step as SpelEchoStep;
        if (echoStep.expression != null && Array.isArray(target.mappings) && target.mappings[0]) {
          target.mappings[0].value = echoStep.expression;
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
 * Walk a V1 mapping tree (which nests OBJECT → CUSTOM / DROPDOWN) and
 * replace the `value` of the first mapping whose `encodingType === "BASE_64"`
 * with the given `newValue`. Returns true if a replacement was made.
 */
function rewriteBase64MappingValue(mappings: V1Mapping[] | undefined, newValue: string): boolean {
  if (!Array.isArray(mappings)) return false;
  for (const m of mappings) {
    if (m.encodingType === "BASE_64" && typeof m.value === "string") {
      m.value = newValue;
      return true;
    }
    if (Array.isArray(m.mappings) && rewriteBase64MappingValue(m.mappings, newValue)) {
      return true;
    }
  }
  return false;
}

/**
 * Find the first leaf mapping in the tree (the deepest mapping with no
 * children that has a `value`). Used as a last-resort target for inline
 * SQL writes.
 */
function findFirstLeafMapping(mappings: V1Mapping[]): V1Mapping | null {
  for (const m of mappings) {
    if (Array.isArray(m.mappings) && m.mappings.length > 0) {
      const leaf = findFirstLeafMapping(m.mappings);
      if (leaf) return leaf;
    } else if (typeof m.value === "string") {
      return m;
    }
  }
  return null;
}

/**
 * The multi-output invariant: every output on a CUSTOM_CODE step beyond the
 * first MUST have `elementToRetrieve` set. The server silently drops outputs
 * that do not; this error surfaces the problem loudly at save time.
 */
function enforceCustomCodeMultiOutputInvariant(step: CustomCodeStep): void {
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

  throw new SerializeError(
    `CUSTOM_CODE step ${step.orderIndex} has ${outputs.length} outputs but ${missing.length} are missing ` +
      `an explicit 'elementToRetrieve': ${missing.join(", ")}. ` +
      `When a custom-code step has multiple outputs, every output MUST set elementToRetrieve or the ` +
      `server will silently drop data. See ad-rest-api-step-types.md §"CRITICAL: For multiple outputs".`,
    step.orderIndex,
  );
}
