// Stage 0.4 — `ad save` safety guard regression tests.
//
// Fixtures:
//   tests/fixtures/real-v1/*.v1.json      36 sanitized real sems-dev V1 bodies
//   tests/fixtures/save-corruption/*      the live corruption case (description-only
//                                         overlay mangled plain-text step 2 code)

import { describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import { CliError } from "@belzabar/core";
import { parseV1Method } from "../../lib/parser/v1";
import { serializeToV1SavePayload } from "../../lib/serialize/v1";
import { buildGuardedV1SavePayload, diffPaths } from "../../lib/serialize/guard";
import { encodeBase64 } from "../../lib/base64";
import type { CustomCodeStep, HydratedMethod, SqlStep } from "../../lib/types/common";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";

const FIX = `${import.meta.dir}/../fixtures`;

async function loadRaw(path: string): Promise<V1RawMethodResponse> {
  return (await Bun.file(path).json()) as V1RawMethodResponse;
}

function inner(json: string): any {
  return JSON.parse(json);
}

function expectCode(fn: () => unknown, code: string): CliError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(code);
    return err as CliError;
  }
  throw new Error(`expected CliError ${code}, nothing was thrown`);
}

function methodFrom(services: unknown[], extra: Record<string, unknown> = {}): HydratedMethod {
  return parseV1Method({
    id: 10,
    uuid: "m-uuid",
    referenceId: "",
    aliasName: "m",
    automationState: "DRAFT",
    version: 3,
    category: { id: 1135, name: "Test-Parth" },
    jsonDefinition: JSON.stringify({ name: "m", methodDescription: "", inputs: [], services, ...extra }),
  } as unknown as V1RawMethodResponse);
}

const realFiles = readdirSync(`${FIX}/real-v1`).filter(f => f.endsWith(".v1.json")).sort();

describe("no-op round-trip over real sems-dev methods", () => {
  test("fixture set is present (36 methods)", () => {
    expect(realFiles.length).toBe(36);
  });

  for (const f of realFiles) {
    test(`serialize(parse(raw)) is deep-equal to raw — ${f.slice(0, 12)}`, async () => {
      const raw = await loadRaw(`${FIX}/real-v1/${f}`);
      const m = parseV1Method(raw);
      const payload = serializeToV1SavePayload(m, { warn: () => {} });
      expect(diffPaths(inner(raw.jsonDefinition), inner(payload.jsonDefinition))).toEqual([]);
    });
  }

  test("plain-text custom code parses as sourceEncoding NONE, verbatim", async () => {
    let plain = 0;
    for (const f of realFiles) {
      const raw = await loadRaw(`${FIX}/real-v1/${f}`);
      const services = inner(raw.jsonDefinition).services ?? [];
      for (const step of parseV1Method(raw).parsedSteps) {
        if (step.kind !== "CUSTOM_CODE" || step.sourceEncoding !== "NONE") continue;
        const svc = services.find((s: any) => s.orderIndex === step.orderIndex);
        expect(step.source).toBe(svc.code ?? "");
        plain++;
      }
    }
    expect(plain).toBeGreaterThan(10);
  });
});

describe("belz-save-corruption case", () => {
  test("description-only overlay changes only that description; step 2 code untouched", async () => {
    const raw = await loadRaw(`${FIX}/save-corruption/before.v1.json`);
    const overlay = await Bun.file(`${FIX}/save-corruption/overlay.json`).json();
    const m = parseV1Method(raw);
    const { payload, applied } = buildGuardedV1SavePayload(m, overlay, { version: 4 });
    expect(applied).toEqual(["parsedSteps[orderIndex=1].description"]);
    const before = inner(raw.jsonDefinition);
    const after = inner(payload.jsonDefinition);
    expect(diffPaths(before, after)).toEqual(["services[0].description"]);
    expect(after.services[1].code).toBe(before.services[1].code);
    expect(after.services[0].description).toBe("Step 1: build greeting (belz overlay test)");
  });

  test("the old corrupted output would be caught by the round-trip diff", async () => {
    const before = inner((await loadRaw(`${FIX}/save-corruption/before.v1.json`)).jsonDefinition);
    const after = inner((await loadRaw(`${FIX}/save-corruption/after.v1.json`)).jsonDefinition);
    expect(diffPaths(before, after)).toContain("services[1].code");
  });

  test("source edit on a plain-text step is written as plain text", async () => {
    const raw = await loadRaw(`${FIX}/save-corruption/before.v1.json`);
    const m = parseV1Method(raw);
    const src = 'const g = "#{greeting}";\nconsole.log(g.toLowerCase());';
    const { payload } = buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 2, source: src }] });
    const after = inner(payload.jsonDefinition);
    expect(after.services[1].code).toBe(src);
    expect(diffPaths(inner(raw.jsonDefinition), after)).toEqual(["services[1].code"]);
  });
});

describe("encoding preservation", () => {
  test("base64-stored custom code stays base64 when edited", () => {
    const m = methodFrom([
      { orderIndex: 1, activeTab: { id: "customCode" }, language: "JAVASCRIPT", code: encodeBase64("console.log('a');"), outputs: [] },
    ]);
    expect((m.parsedSteps[0] as CustomCodeStep).sourceEncoding).toBe("BASE_64");
    const { payload } = buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 1, source: "console.log('b');" }] });
    expect(inner(payload.jsonDefinition).services[0].code).toBe(encodeBase64("console.log('b');"));
  });

  test("plain step: new source that happens to be strict base64 is stored encoded (runtime sniffs)", () => {
    const m = methodFrom([
      { orderIndex: 1, activeTab: { id: "customCode" }, code: "console.log(1)", outputs: [] },
    ]);
    const { payload } = buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 1, source: "YWJj" }] });
    expect(inner(payload.jsonDefinition).services[0].code).toBe(encodeBase64("YWJj"));
  });

  const sqlService = (leaf: Record<string, unknown>) => ({
    orderIndex: 1,
    activeTab: { id: "existingService" },
    automationApiId: 48,
    mappings: [
      {
        value: "",
        uiRepresentation: "OBJECT",
        automationUserInputId: 427,
        mappings: [leaf, { value: "OBJECT", uiRepresentation: "DROPDOWN", automationUserInputId: 25514 }],
      },
    ],
    outputs: [],
  });

  test("plaintext SQL (encodingType NONE) is parsed and written back as plaintext (AD-03)", () => {
    const m = methodFrom([
      sqlService({ value: "select 1", encodingType: "NONE", uiRepresentation: "CUSTOM", automationUserInputId: 428 }),
    ]);
    const step = m.parsedSteps[0] as SqlStep;
    expect(step.kind).toBe("SQL");
    expect(step.sql).toBe("select 1");
    expect(step.sqlEncoding).toBe("NONE");
    const { payload } = buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 1, sql: "select 2" }] });
    const leaf = inner(payload.jsonDefinition).services[0].mappings[0].mappings[0];
    expect(leaf.value).toBe("select 2");
    expect(leaf.encodingType).toBe("NONE");
  });

  test("BASE_64 SQL stays base64", () => {
    const m = methodFrom([
      sqlService({ value: encodeBase64("select 1"), encodingType: "BASE_64", uiRepresentation: "CUSTOM", automationUserInputId: 428 }),
    ]);
    const { payload } = buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 1, sql: "select 2" }] });
    expect(inner(payload.jsonDefinition).services[0].mappings[0].mappings[0].value).toBe(encodeBase64("select 2"));
  });

  test("SQL with no locatable slot → refuses instead of writing the first leaf (AD-03)", () => {
    const m = methodFrom([
      {
        orderIndex: 1,
        activeTab: { id: "existingService" },
        automationApiId: 48,
        mappings: [
          { value: "a", uiRepresentation: "CUSTOM", automationUserInputId: 1 },
          { value: "b", uiRepresentation: "CUSTOM", automationUserInputId: 2 },
        ],
        outputs: [],
      },
    ]);
    expectCode(() => buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 1, sql: "select 2" }] }), "AD_SERIALIZE_FAILED");
  });
});

describe("refusal codes", () => {
  const base = async () => parseV1Method(await loadRaw(`${FIX}/save-corruption/before.v1.json`));

  test("AD_OVERLAY_UNKNOWN_KEY — top-level and nested", async () => {
    const e1 = expectCode(() => buildGuardedV1SavePayload({} as any, { outputs: [] }), "AD_OVERLAY_UNKNOWN_KEY");
    expect(JSON.stringify(e1.details)).toContain("outputs");
    const m = await base();
    expectCode(() => buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 2, code: "x" }] }), "AD_OVERLAY_UNKNOWN_KEY");
  });

  test("AD_OVERLAY_NOT_APPLIED — unwritable method keys", async () => {
    for (const key of ["name", "buttonLabel", "internalMethod"]) {
      const m = await base();
      const e = expectCode(
        () => buildGuardedV1SavePayload(m, { [key]: key === "internalMethod" ? true : "x" }),
        "AD_OVERLAY_NOT_APPLIED",
      );
      expect(JSON.stringify(e.details)).toContain(key);
    }
  });

  test("AD_OVERLAY_NOT_APPLIED — sql on a step not classified as SQL (sems-dev db_service)", async () => {
    const m = await base();
    expect(m.parsedSteps[2]!.kind).toBe("EXISTING_SERVICE");
    const e = expectCode(
      () => buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 3, sql: "select 2" }] }),
      "AD_OVERLAY_NOT_APPLIED",
    );
    expect(e.message).toContain("EXISTING_SERVICE");
  });

  test("AD_OVERLAY_NOT_APPLIED — expression on a non-SPEL_ECHO step, missing orderIndex, unknown input", async () => {
    const m = await base();
    expectCode(() => buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 1, expression: "#{x}" }] }), "AD_OVERLAY_NOT_APPLIED");
    expectCode(() => buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 99, description: "x" }] }), "AD_OVERLAY_NOT_APPLIED");
    expectCode(() => buildGuardedV1SavePayload(m, { inputs: [{ code: "nope", testValue: "x" }] }), "AD_OVERLAY_NOT_APPLIED");
  });

  test("AD_OVERLAY_NOT_APPLIED — value identical to the current one (no effect)", async () => {
    const m = await base();
    const current = (m.parsedSteps[1] as CustomCodeStep).source;
    const e = expectCode(
      () => buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 2, source: current }] }),
      "AD_OVERLAY_NOT_APPLIED",
    );
    expect(e.message).toContain("no change");
  });

  test("AD_OVERLAY_NOT_APPLIED — empty overlay", async () => {
    const m = await base();
    expectCode(() => buildGuardedV1SavePayload(m, {}), "AD_OVERLAY_NOT_APPLIED");
  });

  test("AD_OVERLAY_INVALID — wrong value types", async () => {
    const m = await base();
    expectCode(() => buildGuardedV1SavePayload(m, { summary: 5 }), "AD_OVERLAY_INVALID");
    expectCode(() => buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: "1", description: "x" }] }), "AD_OVERLAY_INVALID");
    expectCode(() => buildGuardedV1SavePayload(m, []), "AD_OVERLAY_INVALID");
  });

  test("AD_SERIALIZER_DRIFT — a change outside the overlay's targets is refused", async () => {
    const m = await base();
    // Simulate a serializer/hydration bug: step 2's source differs from the
    // stored body although the overlay only touches step 1's description.
    (m.parsedSteps[1] as CustomCodeStep).source = "corrupted";
    const e = expectCode(
      () => buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 1, description: "d" }] }),
      "AD_SERIALIZER_DRIFT",
    );
    expect((e.details as { paths: string[] }).paths).toEqual(["services[1].code"]);
  });

  test("AD_SERIALIZE_FAILED — edited multi-output CC step without elementToRetrieve; unedited only warns", () => {
    const svc = {
      orderIndex: 1,
      activeTab: { id: "customCode" },
      code: "console.log(1)",
      outputs: [{ code: "a" }, { code: "b" }],
    };
    const warnings: string[] = [];
    const m1 = methodFrom([svc, { orderIndex: 2, activeTab: { id: "existingService" }, description: "x" }]);
    const r = buildGuardedV1SavePayload(m1, { parsedSteps: [{ orderIndex: 2, description: "y" }] }, { warn: w => warnings.push(w) });
    expect(r.applied).toEqual(["parsedSteps[orderIndex=2].description"]);
    expect(warnings.some(w => w.includes("pre-existing"))).toBe(true);

    const m2 = methodFrom([svc]);
    expectCode(() => buildGuardedV1SavePayload(m2, { parsedSteps: [{ orderIndex: 1, source: "console.log(2)" }] }), "AD_SERIALIZE_FAILED");
  });
});

describe("writable metadata", () => {
  test("summary and description land on inner summary / methodDescription only", async () => {
    const raw = await loadRaw(`${FIX}/save-corruption/before.v1.json`);
    const m = parseV1Method(raw);
    const { payload, applied } = buildGuardedV1SavePayload(m, { summary: "S", description: "D" });
    expect(applied).toEqual(["summary", "description"]);
    const changed = diffPaths(inner(raw.jsonDefinition), inner(payload.jsonDefinition)).sort();
    expect(changed).toEqual(["methodDescription", "summary"]);
    const after = inner(payload.jsonDefinition);
    expect(after.summary).toBe("S");
    expect(after.methodDescription).toBe("D");
  });
});
