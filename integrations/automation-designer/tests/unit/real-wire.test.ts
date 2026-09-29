// Property tests over the real acme-dev wire captures (Stage 1).
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
import type { V1AutomationDefinition, V1RawMethodResponse } from "../../lib/types/v1-wire";
import { buildServiceResolver, identityFromDefinition, resolverFromTable } from "../../lib/hydrator";
import { compactStepLine } from "../../lib/method-view";
import type { ServiceIdentity, ServiceResolver } from "../../lib/parser/steps/classify";
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
    test(`${dir}/manifest.json lists every file, acme-dev, GET endpoint`, async () => {
      const manifest = (await json(`${FIX}/${dir}/manifest.json`)) as Array<{ file: string; env: string; endpoint: string; capturedAt: string }>;
      const files = readdirSync(`${FIX}/${dir}`).filter((f) => f !== "manifest.json").sort();
      expect(manifest.map((m) => m.file).sort()).toEqual(files);
      for (const m of manifest) {
        expect(m.env).toBe("acme-dev");
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

  // AD-35: V2 parser parity.
  test("AD-35: parseV2Method reports the method uuid (top-level wire field)", async () => {
    for (const { uuid, m2 } of await pairs()) {
      expect(m2.uuid).toBe(uuid);
      expect(m2.parseWarnings.some((w) => w.includes("uuid"))).toBe(false);
    }
  });
  test("AD-35: V2 step orderIndex is 1-based like V1", async () => {
    for (const { m1, m2 } of await pairs()) expect(m2.parsedSteps.map((s) => s.orderIndex)).toEqual(m1.parsedSteps.map((s) => s.orderIndex));
  });
});

// AD-02: steps are classified by the service they call. Offline, the service
// identity comes from the captured definitions (/automations/{automationId});
// for automationIds without a captured definition, from the V2 capture of the
// same method at the same moment (V2 names the service on the wire). The
// test below proves those two sources agree wherever both exist.
describe("AD-02 step classification by service identity", () => {
  async function definitionTable(): Promise<Map<string, ServiceIdentity>> {
    const table = new Map<string, ServiceIdentity>();
    for (const f of list("definitions", ".json").filter((f) => f !== "manifest.json")) {
      const def = (await json(`${FIX}/definitions/${f}`)) as V1AutomationDefinition;
      const id = identityFromDefinition(def);
      if (id) table.set(String(def.id), id);
    }
    return table;
  }

  function v1Services(raw1: V1RawMethodResponse): Array<Record<string, any>> {
    return JSON.parse(raw1.jsonDefinition).services ?? [];
  }

  /** Definitions first, then the paired V2 step (same index) for uncaptured automationIds. */
  async function resolverFor(p: Pair, defs: Map<string, ServiceIdentity>): Promise<ServiceResolver> {
    const table = new Map(defs);
    v1Services(p.raw1).forEach((svc, i) => {
      const t = p.raw2.steps?.[i];
      const key = String(svc.automationId);
      if (svc.automationId != null && !table.has(key) && t?.serviceName && t.methodName) {
        table.set(key, { system: t.serviceName, api: t.methodName });
      }
    });
    return resolverFromTable(table);
  }

  test("definition identity == V2 wire identity for every captured automationId", async () => {
    const defs = await definitionTable();
    let checked = 0;
    for (const p of await pairs()) {
      v1Services(p.raw1).forEach((svc, i) => {
        const id = defs.get(String(svc.automationId));
        const t = p.raw2.steps?.[i];
        if (!id || !t?.serviceName) return;
        expect([p.uuid.slice(0, 8), i, id.system, id.api]).toEqual([p.uuid.slice(0, 8), i, t.serviceName, t.methodName ?? ""]);
        checked++;
      });
    }
    expect(checked).toBeGreaterThanOrEqual(60);
  });

  test("V1 step kinds match V2 on acme for all 36 methods; SQL/SpEL/Redis are found", async () => {
    const defs = await definitionTable();
    const counts: Record<string, number> = {};
    for (const p of await pairs()) {
      const m1 = parseV1Method(p.raw1, { env: "acme-dev", resolveService: await resolverFor(p, defs) });
      expect([p.uuid, m1.parsedSteps.map((s) => s.kind)]).toEqual([p.uuid, p.m2.parsedSteps.map((s) => s.kind)]);
      for (const s of m1.parsedSteps) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
    }
    expect(counts.SQL).toBe(41);
    expect(counts.SPEL_ECHO).toBe(4);
    expect((counts.REDIS_GET ?? 0) + (counts.REDIS_SET ?? 0)).toBe(3);
  });

  // ADR-R3: acme names the Redis inputs scope / expirationSeconds / canReplace.
  test("Redis scope, TTL and canReplace parse on V1 and V2 and show in the compact line", async () => {
    const defs = await definitionTable();
    const p = (await pairs()).find((x) => x.uuid.startsWith("44297f3e"))!;
    const m1 = parseV1Method(p.raw1, { env: "acme-dev", resolveService: await resolverFor(p, defs) });
    for (const m of [m1, p.m2]) {
      expect(m.parsedSteps[0]).toMatchObject({ kind: "REDIS_SET", key: "#{lockKey}", value: "first-writer", store: "PERSISTENT", ttlSeconds: "60", overwrite: "true" });
      expect(m.parsedSteps[1]).toMatchObject({ overwrite: "false" });
      expect(m.parsedSteps[2]).toMatchObject({ kind: "REDIS_GET", store: "PERSISTENT" });
    }
    const line = compactStepLine(p.m2.parsedSteps[1]!);
    expect(line).toContain("body.expirationSeconds=60");
    expect(line).toContain("body.canReplace=false");
    expect(line).toContain("body.scope=PERSISTENT");
  });

  test("SQL text, operation and service names agree between V1 and V2", async () => {
    const defs = await definitionTable();
    let n = 0;
    for (const p of await pairs()) {
      const m1 = parseV1Method(p.raw1, { env: "acme-dev", resolveService: await resolverFor(p, defs) });
      m1.parsedSteps.forEach((s, i) => {
        const t = p.m2.parsedSteps[i]!;
        expect(s.serviceName).toBe(t.serviceName!);
        expect(s.methodName).toBe(t.methodName!);
        if (s.kind === "SQL" && t.kind === "SQL") {
          expect(s.sql.length).toBeGreaterThan(0);
          expect(s.sql).toBe(t.sql);
          expect(s.operation).toBe(t.operation);
          n++;
        }
      });
    }
    expect(n).toBe(41);
  });

  test("offline without a resolver, numeric apiIds never classify (ids are env-local; no built-in per-env tables)", async () => {
    const raw1 = (await json(`${FIX}/real-v1/486041dfd02d9fd45a27b608ad2dce0c.v1.json`)) as V1RawMethodResponse;
    for (const opts of [undefined, { env: "acme-dev" }, { env: "other" }]) {
      const kinds = parseV1Method(raw1, opts).parsedSteps.map((s) => s.kind);
      expect(kinds.filter((k) => k === "SQL" || k === "SPEL_ECHO").length).toBe(0);
    }
  });

  test("buildServiceResolver: one lookup per distinct automationId; failures are reported", async () => {
    const raw1 = (await json(`${FIX}/real-v1/41bb1b438875bd8b994196db1f12b7c2.v1.json`)) as V1RawMethodResponse;
    const asked: string[] = [];
    const { resolveService, unresolved } = await buildServiceResolver(raw1, {
      getDefinition: async (id) => {
        asked.push(id);
        return id === "1040" ? ((await json(`${FIX}/definitions/1040.json`)) as V1AutomationDefinition) : null;
      },
    });
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked).toContain("1040");
    expect(unresolved).not.toContain("1040");
    const m = parseV1Method(raw1, { env: "acme-dev", resolveService });
    const sql = m.parsedSteps.find((s) => s.kind === "SQL");
    expect(sql?.kind).toBe("SQL");
    if (sql?.kind === "SQL") {
      expect(sql.operation).toBe("read");
      expect(sql.sql).toContain("select * from enrollment_stage_type");
      expect(sql.sqlInputUuid).toBe("529f4d30-4692-46b3-b1fb-0fea77c68683");
    }
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

  // AD-11 (fixed; ADR-R10 flipped the todos): a 200 with an empty body is METHOD_NOT_FOUND.
  test("AD-11: V1 fetchRawMethod maps 200-empty-body to METHOD_NOT_FOUND", async () => {
    serveEmpty();
    await expect(v1.fetchRawMethod(missing)).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  });
  test("AD-11: V2 fetchRawMethod maps 200-empty-body to METHOD_NOT_FOUND", async () => {
    serveEmpty();
    await expect(v2.fetchRawMethod(missing)).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
  });
});

// ADR-R8: a V2 method output with only fieldCode/name still has a code.
describe("V2 method outputs without `key` (ADR-R8)", () => {
  test("code falls back to fieldCode, then name; matches V1", async () => {
    const uuid = "4a49e392ca76084725c3839ff97007ae";
    const raw2 = (await json(`${FIX}/real-v2/${uuid}.v2.json`)) as V2MethodResponse;
    expect(raw2.outputs?.some((o) => !o.key)).toBe(true);
    const m2 = parseV2Method(raw2, { env: "acme-dev" });
    const m1 = parseV1Method((await json(`${FIX}/real-v1/${uuid}.v1.json`)) as V1RawMethodResponse, { env: "acme-dev" });
    for (const o of m2.outputs) expect(o.code).not.toBe("");
    expect(m2.outputs.map((o) => o.code)).toEqual(m1.outputs.map((o) => o.code));
    expect(parseV2Method({ ...raw2, outputs: [{ name: "onlyName" } as never] }, { env: "acme-dev" }).outputs[0]!.code).toBe("onlyName");
  });
});
