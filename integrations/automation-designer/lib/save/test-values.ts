// Stored input testValues: the AD designer's Test dialog pre-fills its form
// from `jsonDefinition.inputs[].testValue` (V1 only; the V2 body has no such
// key) and reports "Mandatory fields are not filled" when a required input has
// none. Every V2 save drops them (verified live), and belz cannot set them, so
// `save` and `create` say so instead of losing them silently.

import * as v1 from "../api/v1";

/** A stored value counts when it is present and not null / "". */
function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/**
 * Input codes of `uuid` that carry a stored testValue, from a V1 read. Null
 * when the read or its jsonDefinition fails (best effort: never blocks a save).
 */
export async function storedTestValues(uuid: string): Promise<string[] | null> {
  try {
    const raw = await v1.fetchRawMethod(uuid);
    const def = typeof raw.jsonDefinition === "string" ? JSON.parse(raw.jsonDefinition) : raw.jsonDefinition;
    const inputs = Array.isArray(def?.inputs) ? (def.inputs as Array<Record<string, unknown>>) : [];
    return inputs
      .filter((i) => typeof i.fieldCode === "string" && hasValue(i.testValue))
      .map((i) => i.fieldCode as string);
  } catch {
    return null;
  }
}

/** The warning for inputs whose stored testValue a save dropped (or would drop). */
export function testValueDropWarning(codes: string[], tense: "dropped" | "will be dropped"): string {
  return (
    `testValue ${tense} for input(s) [${codes.join(", ")}] by the save (platform: every V2 save strips them). ` +
    `The AD designer's Test dialog reports "Mandatory fields are not filled" until they are re-entered there; ` +
    `'belz ad test --input k=v' runs the method from the CLI without them.`
  );
}

/** The note for a new draft: it stores no testValues, so required inputs trip the designer's Test dialog. */
export function createTestValueNote(requiredInputs: string[]): string {
  return (
    `The new draft stores no testValues (belz cannot set them): the AD designer's Test dialog reports ` +
    `"Mandatory fields are not filled" for required input(s) [${requiredInputs.join(", ")}] until they are entered there; ` +
    `'belz ad test --input k=v' runs the method from the CLI.`
  );
}
