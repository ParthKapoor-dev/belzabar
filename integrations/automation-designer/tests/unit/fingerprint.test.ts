import { describe, expect, test } from "bun:test";
import { fingerprintMethod, stableStringify } from "../../lib/fingerprint";
import type { HydratedMethod } from "../../lib/types/common";

describe("stableStringify", () => {
  test("is insensitive to object key order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  test("is sensitive to values and array order", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  test("handles nested objects and null", () => {
    expect(stableStringify({ x: { d: 1, c: 2 }, y: null })).toBe(
      stableStringify({ y: null, x: { c: 2, d: 1 } }),
    );
  });
});

// fingerprintMethod only reads m.parsedSteps and m.inputs — a partial cast
// keeps these focused without a full HydratedMethod fixture.
function method(steps: unknown[], inputs: unknown[] = []): HydratedMethod {
  return { parsedSteps: steps, inputs } as unknown as HydratedMethod;
}

const codeStep = (orderIndex: number, src: string) => ({
  orderIndex,
  kind: "CUSTOM_CODE",
  description: "do thing",
  language: "JAVASCRIPT",
  source: src,
  inputs: [],
});

describe("fingerprintMethod", () => {
  test("is a stable 12-hex string", () => {
    const fp = fingerprintMethod(method([codeStep(0, "return 1;")]));
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
  });

  test("changes when a step body changes (catches CUSTOM_CODE edits)", () => {
    const a = fingerprintMethod(method([codeStep(0, "return 1;")]));
    const b = fingerprintMethod(method([codeStep(0, "return 2;")]));
    expect(a).not.toBe(b);
  });

  test("is identical for the same logic regardless of step array order", () => {
    const a = fingerprintMethod(method([codeStep(0, "a"), codeStep(1, "b")]));
    const b = fingerprintMethod(method([codeStep(1, "b"), codeStep(0, "a")]));
    expect(a).toBe(b);
  });

  test("ignores env-local identity fields on the step", () => {
    const clean = fingerprintMethod(method([codeStep(0, "x")]));
    const withIds = fingerprintMethod(
      method([{ ...codeStep(0, "x"), automationId: "env-local-uuid", automationApiId: 4127, raw: { junk: 1 } }]),
    );
    expect(clean).toBe(withIds);
  });
});
