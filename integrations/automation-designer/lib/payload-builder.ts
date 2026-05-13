import type { V1RawMethodResponse } from "./types/v1-wire";

/**
 * Inject user-supplied input values onto a V1 raw method response.
 *
 * This helper exists so the SQL module (and legacy callers that haven't
 * migrated to the unified HydratedMethod flow) can take a freshly-fetched
 * V1 response, splice testValues into its inner jsonDefinition, and hand the
 * result back for posting to /chain/test.
 *
 * New code should prefer building a HydratedMethod via adApi.fetchMethod and
 * calling adApi.testExecuteV1 directly — see commands/test/index.ts.
 */
export class PayloadBuilder {
  static injectInputs(
    rawMethod: V1RawMethodResponse,
    inputs: Record<string, unknown>,
  ): V1RawMethodResponse {
    let innerDef: Record<string, unknown> = {};
    try {
      innerDef = JSON.parse(rawMethod.jsonDefinition);
    } catch {
      throw new Error("Failed to parse method jsonDefinition.");
    }

    if (Array.isArray(innerDef.inputs)) {
      innerDef.inputs = (innerDef.inputs as Array<Record<string, unknown>>).map(inp => {
        const fieldCode = typeof inp.fieldCode === "string" ? inp.fieldCode : null;
        if (fieldCode && Object.prototype.hasOwnProperty.call(inputs, fieldCode)) {
          return { ...inp, testValue: inputs[fieldCode] };
        }
        return inp;
      });
    }

    return { ...rawMethod, jsonDefinition: JSON.stringify(innerDef) };
  }
}
