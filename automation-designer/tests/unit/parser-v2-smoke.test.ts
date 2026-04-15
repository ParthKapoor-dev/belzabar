import { describe, expect, test, beforeAll } from "bun:test";
import { parseV2Method, parseMethod } from "../../lib/parser/index";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

describe("parseV2Method (smoke)", () => {
  let raw: V2MethodResponse;

  beforeAll(async () => {
    const file = Bun.file(`${import.meta.dir}/../fixtures/v2/method-smoke.json`);
    raw = (await file.json()) as V2MethodResponse;
  });

  test("identity fields are populated from metadata", () => {
    const method = parseV2Method(raw);
    expect(method.sourceVersion).toBe("v2");
    expect(method.uuid).toBe("v2-draft-uuid-00000000000000000000000000000001");
    expect(method.state).toBe("DRAFT");
    expect(method.version).toBe(1);
    expect(method.referenceId).toBeNull();
  });

  test("name, summary, category", () => {
    const method = parseV2Method(raw);
    expect(method.name).toBe("Calculator.sum");
    expect(method.summary).toBe("Adds two numbers");
    expect(method.category?.name).toBe("Calculator");
    expect(method.category?.uuid).toBe("svc-uuid-abcdef");
  });

  test("maps inputs and outputs", () => {
    const method = parseV2Method(raw);
    expect(method.inputs.length).toBe(2);
    expect(method.inputs[0]!.code).toBe("firstNumber");
    expect(method.inputs[0]!.displayName).toBe("First Number");
    expect(method.outputs.length).toBe(1);
    expect(method.outputs[0]!.code).toBe("sum");
  });

  test("discriminates step kinds via properties.type and serviceName", () => {
    const method = parseV2Method(raw);
    expect(method.parsedSteps.length).toBe(2);

    const echo = method.parsedSteps[0]!;
    expect(echo.kind).toBe("SPEL_ECHO");
    if (echo.kind !== "SPEL_ECHO") throw new Error("kind");
    expect(echo.expression).toBe("#{firstNumber + secondNumber}");

    const cc = method.parsedSteps[1]!;
    expect(cc.kind).toBe("CUSTOM_CODE");
    if (cc.kind !== "CUSTOM_CODE") throw new Error("kind");
    expect(cc.language).toBe("JAVASCRIPT");
    expect(cc.source).toContain("doubled");
    expect(cc.sourceEncoding).toBe("NONE");
  });

  test("parseMethod('v2') dispatches V2 parser", () => {
    const method = parseMethod(raw, "v2");
    expect(method.sourceVersion).toBe("v2");
  });
});
