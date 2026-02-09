import { RawMethodResponse } from "./types";

export class PayloadBuilder {
  static injectInputs(rawMethod: RawMethodResponse, inputs: Record<string, any>): RawMethodResponse {
    let innerDef: any = {};
    try {
        innerDef = JSON.parse(rawMethod.jsonDefinition);
    } catch (e) {
        throw new Error("Failed to parse method jsonDefinition.");
    }

    if (innerDef.inputs) {
        innerDef.inputs = innerDef.inputs.map((inp: any) => {
            if (inputs.hasOwnProperty(inp.fieldCode)) {
                return { ...inp, testValue: inputs[inp.fieldCode] };
            }
            return inp;
        });
    }

    const payload = { ...rawMethod };
    payload.jsonDefinition = JSON.stringify(innerDef);
    return payload;
  }
}
