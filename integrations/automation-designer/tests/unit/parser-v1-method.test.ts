// parseV1Method against a REAL acme-dev V1 body (AD-13: the old hand-written
// method-full.json used `lastUpdatedOn`/`lastUpdatedBy` and string
// `automationId`s, which the wire never sends).
//
// Fixture: tests/fixtures/real-v1/4b108b0554b0daa963f4bd6985f0de52.v1.json
//   PUBLISHED, has referenceId, 3 inputs / 1 variable / 2 outputs,
//   3 existing-service steps + 1 custom-code step.

import { describe, expect, test, beforeAll } from "bun:test";
import { parseV1Method, parseMethod } from "../../lib/parser/index";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";

const FIXTURE = `${import.meta.dir}/../fixtures/real-v1/4b108b0554b0daa963f4bd6985f0de52.v1.json`;

describe("parseV1Method (real wire)", () => {
  let raw: V1RawMethodResponse;
  let inner: any;

  beforeAll(async () => {
    raw = (await Bun.file(FIXTURE).json()) as V1RawMethodResponse;
    inner = JSON.parse(raw.jsonDefinition);
  });

  test("real wire shape: numeric ids, updatedOn/updatedBy, both state fields", () => {
    expect(typeof raw.id).toBe("number");
    expect(typeof raw.updatedOn).toBe("number");
    expect(typeof raw.updatedBy).toBe("number");
    expect(raw.lastUpdatedOn).toBeUndefined();
    expect(raw.state).toBe("PUBLISHED");
    expect(raw.automationState).toBe("PUBLISHED");
    for (const s of inner.services) {
      if (s.automationId !== undefined) expect(typeof s.automationId).toBe("number");
    }
  });

  test("extracts identity from the top-level response", () => {
    const method = parseV1Method(raw);
    expect(method.sourceVersion).toBe("v1");
    expect(method.uuid).toBe(raw.uuid);
    expect(method.referenceId).toBe(raw.referenceId);
    expect(method.state).toBe("PUBLISHED");
    expect(method.aliasName).toBe(raw.aliasName);
    expect(method.version).toBe(raw.version!);
  });

  test("extracts method name and flags from inner jsonDefinition", () => {
    const method = parseV1Method(raw);
    expect(method.name).toBe(inner.name);
    expect(method.name).toBe("internal.match.iteration.report.prepareRepeatedText");
    expect(method.buttonLabel).toBe(inner.buttonLabel);
    expect(method.internalMethod).toBe(false);
  });

  test("extracts category {id, name} from the (much larger) top-level category", () => {
    const method = parseV1Method(raw);
    expect(method.category?.id).toBe(raw.category!.id);
    expect(method.category?.name).toBe("Schools");
  });

  test("maps V1 inputs into unified MethodField shape", () => {
    const method = parseV1Method(raw);
    expect(method.inputs.length).toBe(inner.inputs.length);
    const input = method.inputs[0]!;
    expect(input.code).toBe(inner.inputs[0].fieldCode);
    expect(input.type).toBe(inner.inputs[0].type);
    expect(input.required).toBe(true);
    expect(input.raw).toBeTruthy();
  });

  test("maps method-level variables and outputs", () => {
    const method = parseV1Method(raw);
    expect(method.variables.map((v) => v.code)).toEqual(["finalRepeatText"]);
    expect(method.outputs.map((o) => o.code)).toEqual(["nextPlaceHolder", "finalTextRes"]);
  });

  test("parses services into parsedSteps (1-based orderIndex)", () => {
    const method = parseV1Method(raw);
    expect(method.parsedSteps.map((s) => s.kind)).toEqual(["EXISTING_SERVICE", "EXISTING_SERVICE", "EXISTING_SERVICE", "CUSTOM_CODE"]);
    expect(method.parsedSteps.map((s) => s.orderIndex)).toEqual(inner.services.map((s: any) => s.orderIndex));
  });

  test("preserves raw wire body on the method", () => {
    expect(parseV1Method(raw).raw).toBe(raw);
  });

  test("parseWarnings is empty for a clean real body", () => {
    expect(parseV1Method(raw).parseWarnings).toEqual([]);
  });

  test("parseMethod façade dispatches v1 by default", () => {
    expect(parseMethod(raw, "v1").sourceVersion).toBe("v1");
  });

  test("malformed jsonDefinition adds a warning instead of throwing", () => {
    const broken = { ...raw, jsonDefinition: "not json {" } as V1RawMethodResponse;
    const method = parseV1Method(broken);
    expect(method.parseWarnings.length).toBeGreaterThan(0);
    expect(method.parseWarnings[0]).toContain("Failed to parse jsonDefinition");
    // Falls back to aliasName for the name.
    expect(method.name).toBe(raw.aliasName);
  });

  // AD-13: the wire sends updatedOn/updatedBy (numeric user id), not lastUpdatedOn/lastUpdatedBy.
  test("AD-13: updatedOn/updatedBy are read from the real wire fields", () => {
    const method = parseV1Method(raw);
    expect(typeof raw.updatedOn).toBe("number");
    expect(method.updatedOn).toBe(raw.updatedOn as number);
    expect(method.updatedBy).toBe(String(raw.updatedBy));
  });
});
