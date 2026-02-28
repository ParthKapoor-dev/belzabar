import { describe, expect, test, beforeAll } from "bun:test";
import { parseMethodResponse } from "../../lib/parser";
import type { RawMethodResponse } from "../../lib/types";

describe("Method Parser", () => {
  let rawData: RawMethodResponse;

  beforeAll(async () => {
    const file = Bun.file(import.meta.dir + "/../fixtures/method-draft.json");
    rawData = await file.json();
  });

  test("Extracts Correct Method Name", () => {
    const hydrated = parseMethodResponse(rawData);
    expect(hydrated.methodName).toBe("LT260Owners.update");
  });

  test("Extracts Correct Input Definitions", () => {
    const hydrated = parseMethodResponse(rawData);
    // Fixture has 7 inputs
    expect(hydrated.inputs.length).toBe(7);
    expect(hydrated.inputs[0].fieldCode).toBe("appId");
  });

  test("Extracts Correct Service Count", () => {
    const hydrated = parseMethodResponse(rawData);
    expect(hydrated.services.length).toBe(1);
  });
});
