import { describe, expect, test, beforeAll } from "bun:test";
import { PayloadBuilder } from "../../lib/payload-builder";
import type { RawMethodResponse } from "../../lib/types";

describe("Payload Builder", () => {
  let rawData: RawMethodResponse;

  beforeAll(async () => {
    const file = Bun.file(import.meta.dir + "/../fixtures/method-draft.json");
    rawData = await file.json();
  });

  test("Injects Inputs into JSON Definition", () => {
    const mockInputs = {
      appId: "12345",
      inp2: "test-val"
    };

    const payload = PayloadBuilder.injectInputs(rawData, mockInputs);
    const innerDef = JSON.parse(payload.jsonDefinition);

    // Find the input with fieldCode 'appId'
    const appIdInput = innerDef.inputs.find((i: any) => i.fieldCode === "appId");
    expect(appIdInput).toBeDefined();
    expect(appIdInput.testValue).toBe("12345");

    const inp2 = innerDef.inputs.find((i: any) => i.fieldCode === "inp2");
    expect(inp2.testValue).toBe("test-val");
  });
});
