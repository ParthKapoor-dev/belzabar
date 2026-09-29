// `ad test`, `ad run-suites`, `ad run` over a real sems-dev V1 body
// (fixtures/real-v1/4f6331f1…: 2 steps with NUMERIC automationId and no
// automationApiId, 2 inputs).
// AD-16: automationApiId injection works with numeric ids (one shared helper).
// AD-17: trace rows carry the method's step descriptions / orderIndex.
// AD-38 / F14: run-suites posts the same body as `test`, and surfaces the
// server's message. AD-34: `run` on a DRAFT uuid warns (live sems-dev
// 2026-09-29: it runs the draft's own saved body, not the published copy). Decision (main):
// test/run/run-suites are writes (explicit --env).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  fakeFetch,
  respond,
  runCommand,
  scratchDir,
  withTempEnvConfig,
  type FakeFetch,
  type RecordedRequest,
  type TempEnvConfig,
} from "@belzabar/core/testing";
import testCommand, { matchStep } from "../../commands/test/index";
import runSuitesCommand from "../../commands/run-suites/index";
import saveSuiteCommand from "../../commands/save-suite/index";
import runCommandModule from "../../commands/run/index";
import { buildV1TestPayload } from "../../lib/payload-builder";
import type { ParsedStep } from "../../lib/types/common";

const FIX = join(import.meta.dir, "../fixtures");
const UUID = "4f6331f11208e5ccc8ddaaad20727664";
const rawBody = () => JSON.parse(readFileSync(join(FIX, "real-v1", `${UUID}.v1.json`), "utf8"));
const defTemplate = () => JSON.parse(readFileSync(join(FIX, "definitions", "976.json"), "utf8"));

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  while (spies.length) spies.pop()!.mockRestore();
});

function wire(
  testResponse: (req: RecordedRequest) => unknown,
  body = rawBody(),
  execute: unknown = () => ({ response: { ok: 1 }, executionStatus: { failed: false } }),
) {
  cfg = withTempEnvConfig({ envs: { "t-s4b-run": { url: "https://t-dev.test" } }, activeEnv: "t-s4b-run" });
  spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
  ff = fakeFetch([
    { method: "GET", url: `/rest/api/automation/chain/${UUID}`, response: body },
    {
      method: "GET",
      url: /\/rest\/api\/automations\/(\d+)/,
      response: (req: RecordedRequest) => {
        const id = Number(/automations\/(\d+)/.exec(req.url)![1]);
        const d = defTemplate();
        d.id = id;
        d.automationAPI = { ...d.automationAPI, id: id + 100_000 };
        return d;
      },
    },
    { method: "POST", url: "/rest/api/automation/chain/test", response: testResponse },
    {
      method: "POST",
      url: /\/chain\/execute\//,
      response: execute as never,
    },
  ]).install();
  return ff;
}

/** The JSON body of the multipart `/chain/test` POST. */
async function testBody(f: FakeFetch): Promise<any> {
  const req = f.requests.find((r) => r.url.endsWith("/chain/test"))!;
  // fakeFetch records FormData as [[name, value], ...]
  const entries = JSON.parse(req.body ?? "[]") as Array<[string, string]>;
  return JSON.parse(entries.find(([k]) => k === "body")![1]);
}

const okTestResponse = () => ({
  executionStatus: { failed: false },
  services: [
    { automationId: 38528, executionStatus: { executed: true, failed: false, executionTime: { time: 5, unit: "milliseconds" } } },
    { automationId: 38529, executionStatus: { executed: true, failed: false } },
  ],
  outputs: [{ testResult: '{"a":1}' }],
});

describe("buildV1TestPayload (AD-16 / AD-38)", () => {
  test("numeric automationId gets automationApiId; testValues set; only the 5 test keys", async () => {
    const raw = rawBody();
    const payload = await buildV1TestPayload(raw, { cityCode: "X1" }, {
      getDefinition: async (id) => ({ automationAPI: { id: Number(id) + 1 } }) as any,
    });
    expect(Object.keys(payload).sort()).toEqual(["category", "id", "jsonDefinition", "uuid", "version"]);
    const inner = JSON.parse(payload.jsonDefinition);
    expect(inner.services.map((s: any) => s.automationApiId)).toEqual([38529, 38530]);
    expect(inner.inputs.find((i: any) => i.fieldCode === "cityCode").testValue).toBe("X1");
  });

  test("an existing automationApiId is kept", async () => {
    const raw = rawBody();
    const inner = JSON.parse(raw.jsonDefinition);
    inner.services[0].automationApiId = 5;
    raw.jsonDefinition = JSON.stringify(inner);
    const payload = await buildV1TestPayload(raw, {}, { getDefinition: async () => ({ automationAPI: { id: 9 } }) as any });
    expect(JSON.parse(payload.jsonDefinition).services.map((s: any) => s.automationApiId)).toEqual([5, 9]);
  });
});

describe("ad test", () => {
  test("posts the injected payload; trace rows carry real descriptions + orderIndex (AD-17)", async () => {
    const f = wire(okTestResponse);
    const inputs = join(scratchDir("ad-test"), "in.json");
    writeFileSync(inputs, JSON.stringify({ cityCode: "C", displayName: "D" }));
    const r = await runCommand(testCommand, [UUID, "--inputs", inputs], { env: "t-s4b-run" });
    expect(r.envelope?.ok).toBe(true);
    const body = await testBody(f);
    const inner = JSON.parse(body.jsonDefinition);
    // (exact ids are pinned by the buildV1TestPayload tests; cache-env-scope's
    // test file may already have cached the definitions)
    for (const s of inner.services) expect(s.automationApiId).not.toBeUndefined();
    const d = r.envelope?.data as any;
    expect(d.trace.map((t: any) => t.step)).toEqual([1, 2]);
    expect(d.trace[0].description).toBe("Get the query to fetch loggedIn userId");
    expect(d.trace[0].description).not.toBe("Service");
  });

  test("server error message is surfaced", async () => {
    wire(() => respond({ status: 400, json: { message: "Invalid Automation API Id - 196112" } }));
    const inputs = join(scratchDir("ad-test"), "in.json");
    writeFileSync(inputs, JSON.stringify({ cityCode: "C", displayName: "D" }));
    const r = await runCommand(testCommand, [UUID, "--inputs", inputs], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("TEST_EXECUTION_FAILED");
    expect(r.envelope?.error?.message).toContain("Invalid Automation API Id");
  });

  test("is a write: requires an explicit --env", () => {
    expect((testCommand as any).writes).toBe(true);
    expect((runSuitesCommand as any).writes).toBe(true);
    expect((runCommandModule as any).writes).toBe(true);
  });
});

describe("matchStep (AD-17)", () => {
  const steps = [
    { orderIndex: 1, description: "first", automationId: 10 },
    { orderIndex: 2, description: "second", automationId: 20 },
  ] as unknown as ParsedStep[];
  test("by position, confirmed by automationId; falls back to the id; then to the row", () => {
    expect(matchStep(steps, { automationId: 10 }, 0)).toEqual({ step: 1, description: "first" });
    expect(matchStep(steps, { automationId: 20 }, 0)).toEqual({ step: 2, description: "second" });
    expect(matchStep(steps, { automationId: 99, description: "own" }, 5)).toEqual({ step: 6, description: "own" });
  });
});

describe("ad run-suites (AD-38 / F14)", () => {
  function suitesDir(): string {
    const dir = scratchDir("ad-suites");
    mkdirSync(join(dir, "suites"), { recursive: true });
    writeFileSync(join(dir, "suites", "s1.spec.json"), JSON.stringify({ name: "s1", uuid: ` ${UUID.toUpperCase()}  `, env: "t-s4b-run", inputs: { cityCode: "Z" } }));
    return dir;
  }
  const legacySuite = (dir: string) =>
    writeFileSync(join(dir, "suites", "s1.spec.json"), JSON.stringify({ name: "s1", uuid: UUID, inputs: { cityCode: "Z" } }));

  test("ADW-R13: a legacy suite without env is refused (ENV_MISSING), nothing runs", async () => {
    const dir = suitesDir();
    legacySuite(dir);
    const f = wire(okTestResponse);
    spies.push(spyOn(process, "cwd").mockReturnValue(dir));
    const r = await runCommand(runSuitesCommand, [], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("SUITES_FAILED");
    expect((r.envelope?.data as any).suites[0].reason).toContain("ENV_MISSING");
    expect((r.envelope?.data as any).suites[0].reason).toContain("--legacy-env t-s4b-run");
    expect(f.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(0);
  });

  test("ADW-R13: --legacy-env for another env still refuses; the matching one runs it", async () => {
    const dir = suitesDir();
    legacySuite(dir);
    const f = wire(okTestResponse);
    spies.push(spyOn(process, "cwd").mockReturnValue(dir));
    const other = await runCommand(runSuitesCommand, ["--legacy-env", "nsm-qa"], { env: "t-s4b-run" });
    expect((other.envelope?.data as any).suites[0].reason).toContain("ENV_MISSING");
    expect(f.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(0);
    const same = await runCommand(runSuitesCommand, ["--legacy-env", "t-s4b-run"], { env: "t-s4b-run" });
    expect(same.envelope?.ok).toBe(true);
    expect(f.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(1);
  });

  test("posts the same 5-key test body as `ad test`, with apiIds injected", async () => {
    const dir = suitesDir();
    const f = wire(okTestResponse);
    const cwd = spyOn(process, "cwd").mockReturnValue(dir);
    spies.push(cwd);
    const r = await runCommand(runSuitesCommand, [], { env: "t-s4b-run" });
    expect(r.envelope?.ok).toBe(true);
    const body = await testBody(f);
    expect(Object.keys(body).sort()).toEqual(["category", "id", "jsonDefinition", "uuid", "version"]);
    expect(JSON.parse(body.jsonDefinition).inputs.find((i: any) => i.fieldCode === "cityCode").testValue).toBe("Z");
  });

  test("ADW-R13: a malformed suite fails on its own (INVALID_JSON), the others still run and a summary is returned", async () => {
    const dir = suitesDir();
    writeFileSync(join(dir, "suites", "a-broken.spec.json"), "{ not json");
    const f = wire(okTestResponse);
    spies.push(spyOn(process, "cwd").mockReturnValue(dir));
    const r = await runCommand(runSuitesCommand, [], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("SUITES_FAILED");
    const d = r.envelope?.data as any;
    expect(d.total).toBe(2);
    expect(d.suites.map((x: any) => [x.status, (x.reason ?? "").split(":")[0]])).toEqual([
      ["failed", "INVALID_JSON"],
      ["passed", ""],
    ]);
    expect(f.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(1);
  });

  test("ADW-R13: a suite saved on another env is not run (ENV_MISMATCH)", async () => {
    const dir = suitesDir();
    writeFileSync(join(dir, "suites", "s1.spec.json"), JSON.stringify({ name: "s1", uuid: UUID, env: "nsm-qa", inputs: {} }));
    const f = wire(okTestResponse);
    spies.push(spyOn(process, "cwd").mockReturnValue(dir));
    const r = await runCommand(runSuitesCommand, [], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("SUITES_FAILED");
    expect((r.envelope?.data as any).suites[0].reason).toContain("ENV_MISMATCH");
    expect(f.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(0);
  });

  test("ADW-R13: save-suite records the env the uuid belongs to", async () => {
    const dir = suitesDir();
    wire(okTestResponse);
    spies.push(spyOn(process, "cwd").mockReturnValue(dir));
    const inputs = join(dir, "in.json");
    writeFileSync(inputs, JSON.stringify({ cityCode: "Z", displayName: "D" }));
    const r = await runCommand(saveSuiteCommand, [UUID, "--name", "s2", "--inputs", inputs], { env: "t-s4b-run" });
    expect(r.envelope?.error ?? null).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, "suites", "s2.spec.json"), "utf8"))).toMatchObject({ uuid: UUID, env: "t-s4b-run" });
  });

  test("a 400 reports the server's message, not a bare status", async () => {
    const dir = suitesDir();
    wire(() => respond({ status: 400, json: { message: "Invalid Automation API Id - 1" } }));
    spies.push(spyOn(process, "cwd").mockReturnValue(dir));
    const r = await runCommand(runSuitesCommand, [], { env: "t-s4b-run" });
    expect(r.envelope?.ok).toBe(false);
    expect((r.envelope?.data as any).suites[0].reason).toContain("Invalid Automation API Id - 1");
  });
});

describe("ad run payload file", () => {
  test("a payload file that is not JSON is INVALID_PAYLOAD, not a raw SyntaxError", async () => {
    wire(okTestResponse);
    const f = join(scratchDir("ad-run-payload"), "bad.json");
    writeFileSync(f, "{nope");
    const r = await runCommand(runCommandModule, [UUID, f], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("INVALID_PAYLOAD");
  });
});

describe("ad run (AD-34)", () => {
  test("a DRAFT uuid warns that the draft's saved body runs and names the published copy", async () => {
    const draft = { ...rawBody(), automationState: "DRAFT", referenceId: "0000000000000000000000000000beef" };
    wire(okTestResponse, draft);
    const r = await runCommand(runCommandModule, [UUID, "{}"], { env: "t-s4b-run" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.inputState).toBe("DRAFT");
    expect(d.publishedUuid).toBe("0000000000000000000000000000beef");
    expect(d.executesPublishedUuid).toBeUndefined();
    expect(JSON.stringify(r.envelope?.meta ?? {}) + r.stderr).toContain("runs the draft's saved body");
  });

  test("a failed execute reports details as an object (F38)", async () => {
    wire(okTestResponse, rawBody(), respond({ status: 500, json: { errorMessage: "boom" } }));
    const r = await runCommand(runCommandModule, [UUID, "{}"], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("EXECUTION_FAILED");
    const details = r.envelope?.error?.details as any;
    expect(typeof details).toBe("object");
    expect(details).toMatchObject({ status: 500, body: { errorMessage: "boom" } });
  });

  test("a PUBLISHED uuid runs without the warning", async () => {
    wire(okTestResponse);
    const r = await runCommand(runCommandModule, [UUID, "{}"], { env: "t-s4b-run" });
    const d = r.envelope?.data as any;
    expect(d.inputState).toBe("PUBLISHED");
    expect(d.publishedUuid).toBeUndefined();
  });
});
