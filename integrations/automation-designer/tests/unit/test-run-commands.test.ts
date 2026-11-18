// `ad test`, `ad run-suites`, `ad run` over a real acme-dev V1 body
// (fixtures/real-v1/4f6331f1…: 2 steps with NUMERIC automationId and no
// automationApiId, 2 inputs).
// automationApiId injection works with numeric ids (one shared helper).
// trace rows carry the method's step descriptions / orderIndex.
// run-suites posts the same body as `test`, and surfaces the
// server's message. `run` on a DRAFT uuid warns (live: it runs the draft's
// own saved body, not the published copy). test/run/run-suites are writes
// (explicit --env).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  respond,
  runCommand,
  scratchDir,
  type FakeFetch,
  type RecordedRequest
} from "@belzabar/core/testing";
import testCommand, { matchStep } from "../../commands/test/index";
import runSuitesCommand from "../../commands/run-suites/index";
import saveSuiteCommand from "../../commands/save-suite/index";
import runCommandModule from "../../commands/run/index";
import { buildV1TestPayload } from "../../lib/payload-builder";
import type { ParsedStep } from "../../lib/types/common";
import { definitionRoute, fakeAdEnv } from "./helpers/fake-ad";

const FIX = join(import.meta.dir, "../fixtures");
const UUID = "4f6331f11208e5ccc8ddaaad20727664";
const rawBody = () => JSON.parse(readFileSync(join(FIX, "real-v1", `${UUID}.v1.json`), "utf8"));

const ad = fakeAdEnv({ env: "t-s4b-run" });
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  ad.restore();
  while (spies.length) spies.pop()!.mockRestore();
});

function wire(
  testResponse: (req: RecordedRequest) => unknown,
  body = rawBody(),
  execute: unknown = () => ({ response: { ok: 1 }, executionStatus: { failed: false } }),
) {
  ad.install([
    { method: "GET", url: `/rest/api/automation/chain/${UUID}`, response: body },
    definitionRoute((d, id) => {
      d.id = id;
      d.automationAPI = { ...d.automationAPI, id: id + 100_000 };
    }),
    { method: "POST", url: "/rest/api/automation/chain/test", response: testResponse },
    {
      method: "POST",
      url: /\/chain\/execute\//,
      response: execute as never,
    },
  ]);
  return ad.ff;
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

describe("buildV1TestPayload", () => {
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
  test("posts the injected payload; trace rows carry real descriptions + orderIndex", async () => {
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

  test("a refusal returns its HTTP status and the step's own message (B17, B10)", async () => {
    // the shape /chain/test answered live for an exit-on-failure step with code 403
    wire(() => ({
      executionStatus: { executed: false, failed: true, statusCode: 403, message: "denied by design", failingSteps: [1] },
      services: [{ automationId: 38528, executionStatus: { executed: false, failed: true, statusCode: 403, message: "denied by design" } }],
      outputs: [],
    }));
    const r = await runCommand(testCommand, [UUID, "--inputs", '{"cityCode":"C","displayName":"D"}'], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("AD_TEST_FAILED");
    expect(r.envelope?.error?.message).toBe("The method execution FAILED at step 1 (HTTP 403): denied by design.");
    const d = r.envelope?.data as any;
    expect(d.statusCode).toBe(403);
    expect(d.failedStep.statusCode).toBe(403);
  });

  test("trace: times as numbers, server total, loop ns fixed, async dispatched, rendered SQL (B13, B19, B22)", async () => {
    const body = rawBody();
    const inner = JSON.parse(body.jsonDefinition);
    inner.services[0].repeatStepExecution = true;
    inner.services[1].runAsync = true;
    body.jsonDefinition = JSON.stringify(inner);
    // the shapes /chain/test answered live: a loop step's time in ns labelled "milliseconds",
    // an async step reported not executed, a db step's input rendered in mappings[].testResult
    wire(
      () => ({
        executionStatus: { failed: false, statusCode: 200, executionTime: { time: 396.8, unit: "milliseconds" }, totalExecutionTime: { time: 423.6, unit: "milliseconds" } },
        services: [
          {
            automationId: 38528,
            executionStatus: { executed: true, failed: false, executionTime: { time: 4416738, unit: "milliseconds" } },
            mappings: [{ automationUserInputId: 1, mappings: [{ automationUserInputId: 2, value: "SELECT '#{cityCode}'", mappings: [], testResult: "SELECT 'C'" }] }],
          },
          { automationId: 38529, executionStatus: { executed: false, failed: false } },
        ],
        outputs: [],
      }),
      body,
    );
    const r = await runCommand(testCommand, [UUID, "--inputs", '{"cityCode":"C","displayName":"D"}'], { env: "t-s4b-run" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.timing).toEqual({ executionMs: 396.8, totalMs: 423.6 });
    expect(d.trace[0]).toMatchObject({ step: 1, status: "success", timeMs: 4.416738, totalTime: "4.417ms", loop: true });
    expect(d.trace[1]).toMatchObject({ step: 2, status: "dispatched (async)", timeMs: null, totalTime: "-", async: true });
    expect(d.serviceResults[1].status).toBe("dispatched (async)");
    expect(d.serviceResults[0].renderedInputs).toEqual([{ template: "SELECT '#{cityCode}'", rendered: "SELECT 'C'" }]);
    expect(d.serviceResults[0].sql).toBe("SELECT 'C'");
  });

  test("is a write: requires an explicit --env", () => {
    expect((testCommand as any).writes).toBe(true);
    expect((runSuitesCommand as any).writes).toBe(true);
    expect((runCommandModule as any).writes).toBe(true);
  });
});

describe("matchStep", () => {
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

describe("ad run-suites", () => {
  function suitesDir(): string {
    const dir = scratchDir("ad-suites");
    mkdirSync(join(dir, "suites"), { recursive: true });
    writeFileSync(join(dir, "suites", "s1.spec.json"), JSON.stringify({ name: "s1", uuid: ` ${UUID.toUpperCase()}  `, env: "t-s4b-run", inputs: { cityCode: "Z" } }));
    return dir;
  }
  const legacySuite = (dir: string) =>
    writeFileSync(join(dir, "suites", "s1.spec.json"), JSON.stringify({ name: "s1", uuid: UUID, inputs: { cityCode: "Z" } }));

  test("a legacy suite without env is refused (ENV_MISSING), nothing runs", async () => {
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

  test("--legacy-env for another env still refuses; the matching one runs it", async () => {
    const dir = suitesDir();
    legacySuite(dir);
    const f = wire(okTestResponse);
    spies.push(spyOn(process, "cwd").mockReturnValue(dir));
    const other = await runCommand(runSuitesCommand, ["--legacy-env", "orb-qa"], { env: "t-s4b-run" });
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

  test("a malformed suite fails on its own (INVALID_JSON), the others still run and a summary is returned", async () => {
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

  test("a suite saved on another env is not run (ENV_MISMATCH)", async () => {
    const dir = suitesDir();
    writeFileSync(join(dir, "suites", "s1.spec.json"), JSON.stringify({ name: "s1", uuid: UUID, env: "orb-qa", inputs: {} }));
    const f = wire(okTestResponse);
    spies.push(spyOn(process, "cwd").mockReturnValue(dir));
    const r = await runCommand(runSuitesCommand, [], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("SUITES_FAILED");
    expect((r.envelope?.data as any).suites[0].reason).toContain("ENV_MISMATCH");
    expect(f.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(0);
  });

  test("save-suite records the env the uuid belongs to", async () => {
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

  test("a long inline JSON argument is parsed as JSON, never looked up as a file (B15)", async () => {
    const f = wire(okTestResponse);
    const big = JSON.stringify({ programsJson: "x".repeat(5000) });
    const r = await runCommand(runCommandModule, [UUID, big], { env: "t-s4b-run" });
    expect(r.envelope?.ok).toBe(true);
    const sent = f.requests.find((q) => q.url.includes("/chain/execute/"))!;
    expect(JSON.parse(sent.body!).programsJson).toHaveLength(5000);
    const list = await runCommand(runCommandModule, [UUID, " [1,2]"], { env: "t-s4b-run" });
    expect((list.envelope?.data as any).payloadType).toBe("array");
  });

  test("inline text that starts with { but is not JSON is INVALID_PAYLOAD naming the parse error", async () => {
    wire(okTestResponse);
    const r = await runCommand(runCommandModule, [UUID, "{" + "a".repeat(5000)], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("INVALID_PAYLOAD");
    expect(r.envelope?.error?.message).toContain("not valid JSON");
  });
});

describe("ad run", () => {
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

  test("a failed execute reports details as an object", async () => {
    wire(okTestResponse, rawBody(), respond({ status: 500, json: { errorMessage: "boom" } }));
    const r = await runCommand(runCommandModule, [UUID, "{}"], { env: "t-s4b-run" });
    expect(r.envelope?.error?.code).toBe("EXECUTION_FAILED");
    const details = r.envelope?.error?.details as any;
    expect(typeof details).toBe("object");
    expect(details).toMatchObject({ status: 500, body: { errorMessage: "boom" } });
    expect(r.envelope?.error?.message).toBe("Execution failed (500): boom");
  });

  test("a refusal names the failing step and the method's own message (B10)", async () => {
    const body = {
      executed: false,
      message: JSON.stringify({ result: { message: "INVALID_INPUTS: settingName must be set" } }),
      failed: true,
      statusCode: 400,
      failingSteps: [2],
    };
    wire(okTestResponse, rawBody(), respond({ status: 400, json: JSON.stringify(body) as never }));
    const r = await runCommand(runCommandModule, [UUID, "{}"], { env: "t-s4b-run" });
    expect(r.envelope?.error?.message).toBe("Execution failed (400) at step 2: INVALID_INPUTS: settingName must be set");
    const details = r.envelope?.error?.details as any;
    expect(details.body.message.result.message).toBe("INVALID_INPUTS: settingName must be set");
    expect(details.step).toBe(2);
  });

  test("--repeat N runs N times and reports min / median / max of the server and wall times (B20)", async () => {
    let n = 0;
    const f = wire(okTestResponse, rawBody(), () => ({ ok: 1, executionStatus: { failed: false, totalExecutionTime: { time: [1200, 60, 90][n++], unit: "milliseconds" } } }));
    const r = await runCommand(runCommandModule, [UUID, "{}", "--repeat", "3", "--yes"], { env: "t-s4b-run" });
    expect(r.envelope?.ok).toBe(true);
    const rep = (r.envelope?.data as any).repeat;
    expect(rep.runs).toBe(3);
    expect(rep.serverMs).toMatchObject({ min: 60, median: 90, max: 1200, values: [1200, 60, 90] });
    expect(f.requests.filter((q) => q.url.includes("/chain/execute/"))).toHaveLength(3);
    const llm = await runCommand(runCommandModule, [UUID, "{}", "--repeat", "2"], { env: "t-s4b-run", llm: true });
    expect(llm.envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
  });

  test("a PUBLISHED uuid runs without the warning", async () => {
    wire(okTestResponse);
    const r = await runCommand(runCommandModule, [UUID, "{}"], { env: "t-s4b-run" });
    const d = r.envelope?.data as any;
    expect(d.inputState).toBe("PUBLISHED");
    expect(d.publishedUuid).toBeUndefined();
  });

  test("the output is redacted like ad test: a file link's ?token= and echoed auth headers (I1)", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlc2ln";
    wire(okTestResponse, rawBody(), () => ({
      response: {
        downloadUrl: `https://example.test/rest/api/files/ab12?token=${jwt}`,
        headers: { Authorization: `Bearer ${jwt}` },
        token: "a-data-field",
      },
      executionStatus: { failed: false },
    }));
    const r = await runCommand(runCommandModule, [UUID, "{}"], { env: "t-s4b-run" });
    expect(r.envelope?.ok).toBe(true);
    expect(r.stdout).not.toContain(jwt);
    const resp = (r.envelope?.data as any).response.response;
    expect(resp.downloadUrl).toBe("https://example.test/rest/api/files/ab12?token=[REDACTED]");
    expect(resp.headers.Authorization).toBe("[REDACTED]");
    expect(resp.token).toBe("a-data-field"); // a method's own data field is kept
  });
});
