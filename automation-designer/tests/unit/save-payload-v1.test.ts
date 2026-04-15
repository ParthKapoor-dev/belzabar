import { describe, expect, test, beforeAll } from "bun:test";
import { parseV1Method } from "../../lib/parser/v1";
import { SerializeError, serializeToV1SavePayload } from "../../lib/serialize/v1";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { HydratedMethod, CustomCodeStep } from "../../lib/types/common";
import { encodeBase64 } from "../../lib/base64";

async function loadMethod(): Promise<HydratedMethod> {
  const raw = (await Bun.file(`${import.meta.dir}/../fixtures/v1/method-full.json`).json()) as V1RawMethodResponse;
  return parseV1Method(raw);
}

describe("serializeToV1SavePayload", () => {
  let method: HydratedMethod;

  beforeAll(async () => {
    method = await loadMethod();
  });

  test("emits stringified jsonDefinition", () => {
    const payload = serializeToV1SavePayload(method);
    expect(typeof payload.jsonDefinition).toBe("string");
    const inner = JSON.parse(payload.jsonDefinition);
    expect(inner.name).toBe("UserService.lookupV2");
  });

  test("carries id and uuid on update", () => {
    const payload = serializeToV1SavePayload(method);
    expect(payload.id).toBe(98765);
    expect(payload.uuid).toBe(method.uuid);
  });

  test("omits id and uuid when forCreate=true", () => {
    const payload = serializeToV1SavePayload(method, { forCreate: true });
    expect(payload.id).toBeUndefined();
    expect(payload.uuid).toBeUndefined();
  });

  test("overrides version when provided", () => {
    const payload = serializeToV1SavePayload(method, { version: 42 });
    expect(payload.version).toBe(42);
  });

  test("patches testValue from method.inputs onto inner inputs", () => {
    // Edit the user-facing test value in the unified shape.
    method.inputs[0]!.testValue = "999";
    const payload = serializeToV1SavePayload(method);
    const inner = JSON.parse(payload.jsonDefinition);
    expect(inner.inputs[0].testValue).toBe("999");
  });

  test("carries category", () => {
    const payload = serializeToV1SavePayload(method);
    expect(payload.category).toEqual({ id: 12, name: "UserService" });
  });

  test("round-trips unknown fields via raw", () => {
    // method-full.json's Redis GET step has mappings nested; the serializer
    // should leave them untouched end-to-end.
    const before = JSON.parse((method.raw as V1RawMethodResponse).jsonDefinition);
    const payload = serializeToV1SavePayload(method);
    const after = JSON.parse(payload.jsonDefinition);
    expect(after.services[0].mappings).toEqual(before.services[0].mappings);
  });
});

describe("serializeToV1SavePayload — custom-code multi-output invariant", () => {
  test("rejects CUSTOM_CODE step with >1 outputs missing elementToRetrieve", async () => {
    // Build a synthetic method with a CUSTOM_CODE step whose 2nd output lacks
    // elementToRetrieve.
    const rawResponse: V1RawMethodResponse = {
      id: 1,
      uuid: "cc-uuid",
      referenceId: "",
      aliasName: "cc.test",
      automationState: "DRAFT",
      version: 1,
      category: { id: 1, name: "Test" },
      createdOn: 0,
      lastUpdatedOn: 0,
      lastUpdatedBy: "t",
      jsonDefinition: JSON.stringify({
        name: "cc.test",
        inputs: [],
        services: [
          {
            orderIndex: 1,
            automationId: "cc-1",
            activeTab: { id: "customCode" },
            language: "JAVASCRIPT",
            code: encodeBase64("var o = { a: 1, b: 2 }; console.log(JSON.stringify(o));"),
            outputs: [
              { code: "a", elementToRetrieve: "a" },
              { code: "b" }, // missing — should trigger the error
            ],
          },
        ],
      }),
    };
    const method = parseV1Method(rawResponse);

    expect(() => serializeToV1SavePayload(method)).toThrow(SerializeError);
    try {
      serializeToV1SavePayload(method);
    } catch (err) {
      expect(err).toBeInstanceOf(SerializeError);
      if (err instanceof SerializeError) {
        expect(err.message).toContain("elementToRetrieve");
        expect(err.message).toContain("b");
        expect(err.stepOrderIndex).toBe(1);
      }
    }
  });

  test("allows a single output without elementToRetrieve", async () => {
    const rawResponse: V1RawMethodResponse = {
      id: 2,
      uuid: "cc-single",
      referenceId: "",
      aliasName: "cc.single",
      automationState: "DRAFT",
      version: 1,
      category: { id: 1, name: "Test" },
      createdOn: 0,
      lastUpdatedOn: 0,
      lastUpdatedBy: "t",
      jsonDefinition: JSON.stringify({
        name: "cc.single",
        inputs: [],
        services: [
          {
            orderIndex: 1,
            automationId: "cc-s",
            activeTab: { id: "customCode" },
            language: "JAVASCRIPT",
            code: encodeBase64("console.log('hi');"),
            outputs: [{ code: "out" }],
          },
        ],
      }),
    };
    const method = parseV1Method(rawResponse);
    expect(() => serializeToV1SavePayload(method)).not.toThrow();
  });

  test("allows multi-output when every output has elementToRetrieve", async () => {
    const rawResponse: V1RawMethodResponse = {
      id: 3,
      uuid: "cc-multi-ok",
      referenceId: "",
      aliasName: "cc.ok",
      automationState: "DRAFT",
      version: 1,
      category: { id: 1, name: "Test" },
      createdOn: 0,
      lastUpdatedOn: 0,
      lastUpdatedBy: "t",
      jsonDefinition: JSON.stringify({
        name: "cc.ok",
        inputs: [],
        services: [
          {
            orderIndex: 1,
            automationId: "cc-ok",
            activeTab: { id: "customCode" },
            language: "JAVASCRIPT",
            code: encodeBase64("var o = {a:1,b:2}; console.log(JSON.stringify(o));"),
            outputs: [
              { code: "a", elementToRetrieve: "a" },
              { code: "b", elementToRetrieve: "b" },
            ],
          },
        ],
      }),
    };
    const method = parseV1Method(rawResponse);
    expect(() => serializeToV1SavePayload(method)).not.toThrow();
  });
});

describe("serializeToV1SavePayload — source rewrite", () => {
  test("re-encodes custom-code source when modified", async () => {
    const rawResponse: V1RawMethodResponse = {
      id: 4,
      uuid: "cc-edit",
      referenceId: "",
      aliasName: "cc.edit",
      automationState: "DRAFT",
      version: 1,
      category: { id: 1, name: "Test" },
      createdOn: 0,
      lastUpdatedOn: 0,
      lastUpdatedBy: "t",
      jsonDefinition: JSON.stringify({
        name: "cc.edit",
        inputs: [],
        services: [
          {
            orderIndex: 1,
            automationId: "cc-e",
            activeTab: { id: "customCode" },
            language: "JAVASCRIPT",
            code: encodeBase64("console.log('original');"),
            outputs: [{ code: "out" }],
          },
        ],
      }),
    };
    const method = parseV1Method(rawResponse);
    const step = method.parsedSteps[0] as CustomCodeStep;
    step.source = "console.log('edited');";

    const payload = serializeToV1SavePayload(method);
    const inner = JSON.parse(payload.jsonDefinition);
    const reencoded = inner.services[0].code;
    expect(Buffer.from(reencoded, "base64").toString("utf-8")).toBe("console.log('edited');");
  });
});
