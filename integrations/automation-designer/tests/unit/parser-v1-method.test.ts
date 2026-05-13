import { describe, expect, test, beforeAll } from "bun:test";
import { parseV1Method, parseMethod } from "../../lib/parser/index";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";

describe("parseV1Method", () => {
  let raw: V1RawMethodResponse;

  beforeAll(async () => {
    const file = Bun.file(`${import.meta.dir}/../fixtures/v1/method-full.json`);
    raw = (await file.json()) as V1RawMethodResponse;
  });

  test("extracts identity from the top-level response", () => {
    const method = parseV1Method(raw);
    expect(method.sourceVersion).toBe("v1");
    expect(method.uuid).toBe(raw.uuid);
    expect(method.referenceId).toBe(raw.referenceId);
    expect(method.state).toBe("DRAFT");
    expect(method.aliasName).toBe("UserService.lookupV2");
    expect(method.version).toBe(3);
  });

  test("extracts method name from inner jsonDefinition", () => {
    const method = parseV1Method(raw);
    expect(method.name).toBe("UserService.lookupV2");
    expect(method.summary).toBe("Resolve a user, cache-first");
    expect(method.description).toBe("Reads from Redis, falls back to DB, re-caches.");
    expect(method.buttonLabel).toBe("Lookup User");
    expect(method.internalMethod).toBe(false);
  });

  test("extracts category from top-level", () => {
    const method = parseV1Method(raw);
    expect(method.category?.name).toBe("UserService");
    expect(method.category?.id).toBe(12);
  });

  test("maps V1 inputs into unified MethodField shape", () => {
    const method = parseV1Method(raw);
    expect(method.inputs.length).toBe(1);
    const input = method.inputs[0]!;
    expect(input.code).toBe("userId");
    expect(input.displayName).toBe("User ID");
    expect(input.type).toBe("TEXT");
    expect(input.required).toBe(true);
    expect(input.testValue).toBe("42");
    expect(input.raw).toBeTruthy();
  });

  test("maps method-level variables", () => {
    const method = parseV1Method(raw);
    expect(method.variables.length).toBe(1);
    expect(method.variables[0]!.code).toBe("resolvedUser");
    expect(method.variables[0]!.hideInput).toBe(true);
  });

  test("maps method-level outputs", () => {
    const method = parseV1Method(raw);
    expect(method.outputs.length).toBe(1);
    expect(method.outputs[0]!.code).toBe("resolvedUser");
  });

  test("parses services into parsedSteps", () => {
    const method = parseV1Method(raw);
    expect(method.parsedSteps.length).toBe(1);
    expect(method.parsedSteps[0]!.kind).toBe("REDIS_GET");
  });

  test("preserves raw wire body on the method", () => {
    const method = parseV1Method(raw);
    expect(method.raw).toBe(raw);
  });

  test("parseWarnings is empty for a clean fixture", () => {
    const method = parseV1Method(raw);
    expect(method.parseWarnings).toEqual([]);
  });

  test("parseMethod façade dispatches v1 by default", () => {
    const method = parseMethod(raw, "v1");
    expect(method.sourceVersion).toBe("v1");
  });

  test("malformed jsonDefinition adds a warning instead of throwing", () => {
    const broken = { ...raw, jsonDefinition: "not json {" } as V1RawMethodResponse;
    const method = parseV1Method(broken);
    expect(method.parseWarnings.length).toBeGreaterThan(0);
    expect(method.parseWarnings[0]).toContain("Failed to parse jsonDefinition");
    // Falls back to aliasName for the name.
    expect(method.name).toBe("UserService.lookupV2");
  });
});
