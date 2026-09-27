// Property tests over the real sems-dev wire captures (Stage 1).
//
// Fixtures (captured by scripts/fixtures/capture.ts, sanitized, see each
// dir's manifest.json):
//   real-v1/      36 V1 bodies   GET /rest/api/automation/chain/{uuid}
//   real-v2/      same 36, V2    GET /rest/api/automation/chain/v2/{uuid}?basicInfo=false
//   definitions/  step records   GET /rest/api/automations/{automationId}?basicinfo=false
//   categories/   AD-09/AD-10 identity sources: /chain/category (+system) and /automation/services
//   not-found/    200 + empty body for a nonexistent uuid (V1 and V2)
//
// Known gaps are `test.todo` with the bug id; each todo carries the real
// assertion so `bun test --todo` shows when a later stage fixes it.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import { fakeFetch, fixture, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { parseV1Method } from "../../lib/parser/v1";
import { parseV2Method } from "../../lib/parser/v2";
import * as v1 from "../../lib/api/v1";
import * as v2 from "../../lib/api/v2";
import type { HydratedMethod } from "../../lib/types/common";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

const FIX = `${import.meta.dir}/../fixtures`;
const json = (p: string) => Bun.file(p).json();
const list = (dir: string, suffix: string) => readdirSync(`${FIX}/${dir}`).filter((f) => f.endsWith(suffix)).sort();

const v1Files = list("real-v1", ".v1.json");
const uuids = v1Files.map((f) => f.slice(0, 32));

interface Pair { uuid: string; raw1: V1RawMethodResponse; raw2: V2MethodResponse & Record<string, any>; m1: HydratedMethod; m2: HydratedMethod }
async function pairs(): Promise<Pair[]> {
  const out: Pair[] = [];
  for (const uuid of uuids) {
    const raw1 = (await json(`${FIX}/real-v1/${uuid}.v1.json`)) as V1RawMethodResponse;
    const raw2 = (await json(`${FIX}/real-v2/${uuid}.v2.json`)) as V2MethodResponse & Record<string, any>;
    out.push({ uuid, raw1, raw2, m1: parseV1Method(raw1), m2: parseV2Method(raw2) });
  }
  return out;
}

describe("fixture inventory + manifests", () => {
  test("36 V1 and the same 36 uuids in V2", () => {
    expect(uuids.length).toBe(36);
    expect(list("real-v2", ".v2.json").map((f) => f.slice(0, 32))).toEqual(uuids);
  });

  for (const dir of ["real-v1", "real-v2", "definitions", "categories", "not-found"]) {
    test(`${dir}/manifest.json lists every file, sems-dev, GET endpoint`, async () => {
      const manifest = (await json(`${FIX}/${dir}/manifest.json`)) as Array<{ file: string; env: string; endpoint: string; capturedAt: string }>;
      const files = readdirSync(`${FIX}/${dir}`).filter((f) => f !== "manifest.json").sort();
      expect(manifest.map((m) => m.file).sort()).toEqual(files);
      for (const m of manifest) {
        expect(m.env).toBe("sems-dev");
        expect(m.endpoint.startsWith("/rest/api/")).toBe(true);
        expect(Number.isNaN(Date.parse(m.capturedAt))).toBe(false);
      }
    });
  }
});

describe("V1 real wire shape (AD-13)", () => {
  test("numeric id / step automationId, updatedOn not lastUpdatedOn, state + automationState agree", async () => {
    let withUpdatedOn = 0;
    for (const { raw1 } of await pairs()) {
      expect(typeof raw1.id).toBe("number");
      expect(raw1.lastUpdatedOn).toBeUndefined();
      expect(raw1.lastUpdatedBy).toBeUndefined();
      // Never-edited methods omit updatedOn/updatedBy entirely.
      if (raw1.updatedOn !== undefined) {
        expect(typeof raw1.updatedOn).toBe("number");
        withUpdatedOn++;
      }
      expect(raw1.state).toBe(raw1.automationState!);
      for (const s of JSON.parse(raw1.jsonDefinition).services ?? []) {
        if (s.automationId !== undefined) expect(typeof s.automationId).toBe("number");
      }
    }
    expect(withUpdatedOn).toBe(27);
  });
});

describe("V2 parse vs V1 parse (same method, same moment)", () => {
  test("parseV2Method never throws; state, name, version, referenceId, category, step count and I/O counts match V1", async () => {
    const ps = await pairs();
    for (const { uuid, m1, m2 } of ps) {
      const ctx = uuid.slice(0, 12);
      expect([ctx, m2.state]).toEqual([ctx, m1.state]);
      expect([ctx, m2.name]).toEqual([ctx, m1.name]);
      expect([ctx, m2.version]).toEqual([ctx, m1.version]);
      expect([ctx, m2.referenceId]).toEqual([ctx, m1.referenceId]);
      expect([ctx, m2.category?.id]).toEqual([ctx, m1.category?.id]);
      expect([ctx, m2.parsedSteps.length]).toEqual([ctx, m1.parsedSteps.length]);
      expect([ctx, m2.inputs.length, m2.outputs.length, m2.variables.length]).toEqual([ctx, m1.inputs.length, m1.outputs.length, m1.variables.length]);
    }
  });

  test("custom-code source decodes identically on V1 and V2 (plain and base64 at rest)", async () => {
    let n = 0;
    for (const { m1, m2 } of await pairs()) {
      m1.parsedSteps.forEach((s, i) => {
        const t = m2.parsedSteps[i]!;
        if (s.kind === "CUSTOM_CODE" && t.kind === "CUSTOM_CODE") {
          expect(t.source).toBe(s.source);
          n++;
        }
      });
    }
    expect(n).toBeGreaterThanOrEqual(20);
  });

  test("V2 top-level uuid equals the V1 uuid (the wire has no metadata.uuid)", async () => {
    for (const { uuid, raw2 } of await pairs()) {
      expect(raw2.uuid).toBe(uuid);
      expect(raw2.metadata?.uuid).toBeUndefined();
    }
  });

  // AD-35: V2 parser parity gaps.
  test.todo("AD-35: parseV2Method reports the method uuid (reads metadata.uuid; empty on all 36)", async () => {
    for (const { uuid, m2 } of await pairs()) expect(m2.uuid).toBe(uuid);
  });
  test.todo("AD-35: V2 step orderIndex is 1-based like V1 (V2 is 0-based today; 34 of 36 differ)", async () => {
    for (const { m1, m2 } of await pairs()) expect(m2.parsedSteps.map((s) => s.orderIndex)).toEqual(m1.parsedSteps.map((s) => s.orderIndex));
  });
  // AD-02: V1 classifies by nsm-numeric automationApiIds, so on sems it misses
  // REDIS_SET/GET (44297f3e…) and SPEL_ECHO (46f978f8…, 486041df…) that V2 finds by service name.
  test.todo("AD-02: V1 step kinds match V2 on sems (3 of 36 methods differ)", async () => {
    for (const { m1, m2 } of await pairs()) expect(m1.parsedSteps.map((s) => s.kind)).toEqual(m2.parsedSteps.map((s) => s.kind));
  });
});

describe("service definitions (/automations/{automationId})", () => {
  test("each record's id is the numeric automationId used by its V1 method(s)", async () => {
    const manifest = (await json(`${FIX}/definitions/manifest.json`)) as Array<{ file: string; source: { automationId: string; usedBy: string[] } }>;
    expect(manifest.length).toBeGreaterThanOrEqual(10);
    const methodsCovered = new Set(manifest.flatMap((m) => m.source.usedBy));
    expect(methodsCovered.size).toBe(10);
    for (const m of manifest) {
      const def = await json(`${FIX}/definitions/${m.file}`);
      expect(def.id).toBe(Number(m.source.automationId));
      expect(typeof def.automationAPI?.id).toBe("number");
      for (const uuid of m.source.usedBy) {
        const services = JSON.parse(((await json(`${FIX}/real-v1/${uuid}.v1.json`)) as V1RawMethodResponse).jsonDefinition).services;
        expect(services.some((s: any) => s.automationId === def.id)).toBe(true);
      }
    }
  });
});

describe("category identity sources (AD-09/AD-10)", () => {
  test("/chain/category is a list of {id, name}; /automation/services is {currentOffset, result[]}", async () => {
    const chain = (await json(`${FIX}/categories/chain-category.json`)) as Array<{ id: number; name: string }>;
    const withSystem = (await json(`${FIX}/categories/chain-category-system.json`)) as unknown[];
    const services = (await json(`${FIX}/categories/automation-services.json`)) as { currentOffset: unknown; result: unknown[] };
    expect(chain.length).toBeGreaterThan(50);
    for (const c of chain) {
      expect(typeof c.id).toBe("number");
      expect(typeof c.name).toBe("string");
    }
    expect(Array.isArray(withSystem)).toBe(true);
    expect(Array.isArray(services.result)).toBe(true);
    expect(services.result.length).toBeGreaterThan(0);
  });

  test("every real method's category id is present in /chain/category", async () => {
    const ids = new Set(((await json(`${FIX}/categories/chain-category.json`)) as Array<{ id: number }>).map((c) => c.id));
    for (const { m1 } of await pairs()) expect(ids.has(m1.category!.id as number)).toBe(true);
  });
});

describe("not-found (200 + empty body)", () => {
  let ff: FakeFetch | null = null;
  let cfg: TempEnvConfig | null = null;
  afterEach(() => {
    ff?.restore();
    cfg?.restore();
    ff = null;
    cfg = null;
  });

  test("the server answers a missing uuid with 200 and an empty body on V1 and V2", async () => {
    for (const f of ["v1-chain-missing.json", "v2-chain-missing.json"]) {
      const cap = await json(`${FIX}/not-found/${f}`);
      expect(cap).toEqual({ status: 200, contentType: "", body: "" });
    }
  });

  const missing = "00000000000000000000000000000000";
  const serveEmpty = () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch({ "GET /rest/api/automation/chain/*": respond({ status: 200, text: "" }) }).install();
  };

  test("replay: a real V2 body served through apiFetch parses like the file", async () => {
    const uuid = "4b108b0554b0daa963f4bd6985f0de52";
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch({ "GET /rest/api/automation/chain/v2/*": fixture(`${FIX}/real-v2/${uuid}.v2.json`) }).install();
    const raw = await v2.fetchRawMethod(uuid);
    expect(raw).toEqual(await json(`${FIX}/real-v2/${uuid}.v2.json`));
    expect(ff.requests[0]!.url).toBe(`https://t-dev.test/rest/api/automation/chain/v2/${uuid}?basicInfo=false`);
  });

  // AD-11: the empty body reaches response.json() and surfaces as an unhandled SyntaxError.
  test.todo("AD-11: V1 fetchRawMethod maps 200-empty-body to METHOD_NOT_FOUND", async () => {
    serveEmpty();
    await expect(v1.fetchRawMethod(missing)).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  });
  test.todo("AD-11: V2 fetchRawMethod maps 200-empty-body to METHOD_NOT_FOUND", async () => {
    serveEmpty();
    await expect(v2.fetchRawMethod(missing)).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  });
});
