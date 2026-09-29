import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { diffPaths, fingerprintMethod, fingerprintProjection, stableStringify } from "../../lib/fingerprint";
import { parseV1Method, parseV2Method } from "../../lib/parser/index";
import { encodeBase64 } from "../../lib/base64";
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

// ─── ADW-R2: the fingerprint covers everything that changes behaviour ─────


const FIX = join(import.meta.dir, "../fixtures");
const readJson = (p: string) => JSON.parse(readFileSync(join(FIX, p), "utf8"));
const BASE = "real-v2/41bb1b438875bd8b994196db1f12b7c2.v2.json";
// Wire bodies are mutated freely in the table below; typing each path adds nothing.
type Body = any;
const fpOf = (body: Body) => fingerprintMethod(parseV2Method(body));
const mutated = (fn: (b: Body) => void) => {
  const b = readJson(BASE);
  fn(b);
  return fpOf(b);
};

describe("fingerprintMethod over the wire body (ADW-R2)", () => {
  const base = fpOf(readJson(BASE));

  const BEHAVIOUR: Array<[string, (b: Body) => void]> = [
    ["step output fieldCode", (b) => (b.steps[0].outputs[0].fieldCode = "other")],
    ["step output key", (b) => (b.steps[0].outputs[1].key = "rows")],
    ["step output elementToRetrieve", (b) => (b.steps[1].outputs[0].elementToRetrieve = "x")],
    ["step output inputReference", (b) => (b.steps[1].outputs[0].inputReference = "v")],
    ["method output added", (b) => (b.outputs = [{ key: "out", type: "TEXT" }])],
    ["method output key", (b) => (b.outputs = [{ key: "out2", type: "TEXT" }])],
    ["variable added", (b) => (b.variables = [{ key: "v", type: "TEXT" }])],
    ["method input required", (b) => (b.inputs[0].required = true)],
    ["method input default", (b) => (b.inputs[0].defaultValue = "x")],
    ["runAsync", (b) => (b.steps[2].properties.runAsync = true)],
    ["exitOnFailure", (b) => (b.steps[0].properties.exitCondition.exitOnFailure.value = true)],
    ["exit message", (b) => (b.steps[0].properties.exitCondition.exitOnFailure.message = "boom")],
    ["conditional exit", (b) => (b.steps[0].properties.exitCondition.conditionalExit.expression = "#{x} eq 1")],
    ["entry condition", (b) => (b.steps[0].properties.entryCondition.expression = "#{code} eq null")],
    ["loop", (b) => (b.steps[2].properties.repeatStepExecution = { type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{rows}" })],
    ["account (by name)", (b) => (b.steps[0].accountConfiguration = { id: 3, name: "Other-DB" })],
    ["SQL text", (b) => (b.steps[0].inputs[0].properties[0].value = "select 1")],
    ["input combineInput", (b) => (b.steps[0].inputs[0].properties[0].combineInput = false)],
    ["custom code", (b) => (b.steps[1].properties.customCode.inlineCode = "return 1;")],
    ["code language", (b) => (b.steps[1].properties.customCode.language = "PYTHON")],
    ["called service", (b) => (b.steps[2].methodName = "data.update")],
    ["step order", (b) => b.steps.splice(0, 2, b.steps[1], b.steps[0])],
    ["step removed", (b) => b.steps.pop()],
    ["step description", (b) => (b.steps[0].description = "changed")],
    ["method name", (b) => (b.name = "renamed")],
    ["category", (b) => (b.metadata.service.name = "Elsewhere")],
    ["time limit", (b) => (b.metadata.executionTimeLimit = 5)],
  ];
  for (const [what, fn] of BEHAVIOUR) {
    test(`changes with: ${what}`, () => expect(mutated(fn)).not.toBe(base));
  }

  const BOOKKEEPING: Array<[string, (b: Body) => void]> = [
    ["step ids", (b) => b.steps.forEach((s: Body, i: number) => (s.id = `new${i}`))],
    ["input uuids", (b) => (b.inputs[0].uuid = "x")],
    ["automationAPIId", (b) => (b.steps[0].automationAPIId = "other")],
    ["account id (env-local)", (b) => (b.steps[0].accountConfiguration.id = 99)],
    ["version", (b) => (b.metadata.version = { name: "99" })],
    ["state / referenceId", (b) => ((b.metadata.state = "PUBLISHED"), (b.metadata.referenceId = "abc"), (b.automationState = "PUBLISHED"))],
    ["audit stamps", (b) => (b.metadata.internal = { createdAt: 1 })],
    ["changelogs", (b) => (b.changelogs = [{ note: "x" }])],
    ["testSuite", (b) => delete b.testSuite],
    ["permissions", (b) => (b.permissions = { permissionSet: [] })],
    ["method uuid", (b) => (b.uuid = "ffffffffffffffffffffffffffffffff")],
    ["env-local numeric …Id fields", (b) => ((b.steps[0].outputs[0].automationAPIOutputId = 12908), (b.steps[0].accountId = "42"))],
    ["base64 vs plain custom code", (b) => (b.steps[1].properties.customCode.inlineCode = encodeBase64(b.steps[1].properties.customCode.inlineCode))],
  ];
  for (const [what, fn] of BOOKKEEPING) {
    test(`ignores: ${what}`, () => expect(mutated(fn)).toBe(base));
  }

  test("an unchanged draft matches its published copy (real sems-dev pairs, different step ids)", () => {
    const dir = join(FIX, "draft-published");
    const pubs = readdirSync(dir).filter((f) => f.endsWith(".published.v2.json"));
    expect(pubs.length).toBe(8);
    let same = 0;
    for (const f of pubs) {
      const pub = readJson(`draft-published/${f}`);
      const draft = readJson(`draft-published/${pub.metadata.referenceId}.draft.v2.json`);
      expect(draft.steps.map((s: Body) => s.id)).not.toEqual(pub.steps.map((s: Body) => s.id));
      const a = parseV2Method(draft);
      const b = parseV2Method(pub);
      if (fingerprintMethod(a) === fingerprintMethod(b)) same++;
      // 4bfc83c7: the draft really moved to another category; nothing else differs.
      else expect(diffPaths(fingerprintProjection(a), fingerprintProjection(b))).toEqual(["$.metadata.service"]);
    }
    expect(same).toBe(7);
  });

  test("V1 bodies: ids ignored, the SQL / code body counts", () => {
    const raw = readJson("real-v1/41bb1b438875bd8b994196db1f12b7c2.v1.json");
    const fp = fingerprintMethod(parseV1Method(raw));
    const jd = JSON.parse(raw.jsonDefinition);
    jd.services.forEach((s: Body) => (s.automationId = "other"));
    expect(fingerprintMethod(parseV1Method({ ...raw, jsonDefinition: JSON.stringify(jd) }))).toBe(fp);
    jd.services[0].description = "changed";
    expect(fingerprintMethod(parseV1Method({ ...raw, jsonDefinition: JSON.stringify(jd) }))).not.toBe(fp);
  });

  test("a step that calls a different method / service / account changes it (V2)", () => {
    const base = fpOf(readJson(BASE));
    expect(mutated((b) => (b.steps[2].methodName = "other.method"))).not.toBe(base); // child method
    expect(mutated((b) => (b.steps[2].serviceName = "OtherCategory"))).not.toBe(base); // its category / service
    expect(mutated((b) => (b.steps[0].accountConfiguration = { id: 3, name: "Other-Account" }))).not.toBe(base);
  });

  test("V1: a step bound to a different API (automationApiUuid) changes it; padding / case / dashes do not", () => {
    const raw = readJson("real-v1/4567eb19c7bad64d88859e387b9d986f.v1.json");
    const fp = (mut: (jd: Body) => void) => {
      const jd = JSON.parse(raw.jsonDefinition);
      mut(jd);
      return fingerprintMethod(parseV1Method({ ...raw, jsonDefinition: JSON.stringify(jd) }));
    };
    const base = fp(() => {});
    const svc = (jd: Body, n: number) => jd.services.find((s: Body) => s.orderIndex === n);
    expect(fp((jd) => (svc(jd, 1).automationApiUuid = "4ffffffffffffffffffffffffffffff0"))).not.toBe(base);
    expect(fp((jd) => (svc(jd, 1).automationApiUuid = svc(jd, 1).automationApiUuid.trim().toUpperCase()))).toBe(base);
    expect(fp((jd) => (svc(jd, 3).automationApiUuid = svc(jd, 3).automationApiUuid.replace(/-/g, "")))).toBe(base);
  });

  test("a padded uuid (live: V1 automationUuid read back padded after a restore) matches the unpadded one", () => {
    const withUuid = (v: string) => mutated((b) => (b.steps[0].outputs[0].automationUuid = v));
    const bare = withUuid("4f11484a706062c55fafb7dde8ae3fd2");
    expect(withUuid("4f11484a706062c55fafb7dde8ae3fd2    ")).toBe(bare);
    expect(withUuid("4F11484A-7060-62C5-5FAF-B7DDE8AE3FD2")).toBe(bare);
    expect(withUuid("4f11484a706062c55fafb7dde8ae3fd3")).not.toBe(bare);
  });
});
