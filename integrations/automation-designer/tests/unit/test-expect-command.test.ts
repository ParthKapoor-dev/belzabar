// 7.7 / 7.12: `ad test --expect`, `--case` and `--compare-published` over the
// real acme-dev bodies of belz_tst_s7c_t1 (fixtures/test-cases: draft
// 4252b87e… whose echo was changed to "Hi #{name}", and its published copy
// 4725bcfb… still saying "Hello #{name}") and the real /chain/test answers.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fakeFetch, runCommand, scratchDir, withTempEnvConfig, type FakeFetch, type RecordedRequest, type TempEnvConfig } from "@belzabar/core/testing";
import testCommand from "../../commands/test/index";
import { counterpart, diffOutputs, outputsMap } from "../../lib/test-run";

const FIX = join(import.meta.dir, "../fixtures");
const DRAFT = "4252b87e4d77d2a6e8f59325550558ae";
const PUB = "4725bcfbb9d1e3c7eeb489dc0293d96a";
const load = (f: string) => JSON.parse(readFileSync(join(FIX, "test-cases", f), "utf8"));
const ENV = "t-s7c-test";

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

/** The multipart /chain/test body's `uuid`: which chain a test POST ran. */
function testedUuid(req: RecordedRequest): string {
  const entries = JSON.parse(req.body ?? "[]") as Array<[string, string]>;
  return JSON.parse(entries.find(([k]) => k === "body")![1]).uuid;
}

function wire(opts: { failed?: boolean } = {}) {
  cfg = withTempEnvConfig({ envs: { [ENV]: { url: "https://t-dev.test" } }, activeEnv: ENV });
  spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
  ff = fakeFetch([
    { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: load("draft.v1.json") },
    { method: "GET", url: `/rest/api/automation/chain/${PUB}`, response: load("published.v1.json") },
    {
      method: "GET",
      url: /\/rest\/api\/automations\/(\d+)/,
      response: () => JSON.parse(readFileSync(join(FIX, "definitions", "976.json"), "utf8")),
    },
    {
      method: "POST",
      url: "/rest/api/automation/chain/test",
      response: (req: RecordedRequest) => {
        const body = testedUuid(req) === PUB ? load("test-published.json") : load("test-draft.json");
        if (opts.failed) body.executionStatus.failed = true;
        return body;
      },
    },
  ]).install();
  const inputs = join(scratchDir("ad-test-expect"), "in.json");
  writeFileSync(inputs, JSON.stringify({ name: "World" }));
  return inputs;
}

describe("ad test --expect (7.7)", () => {
  test("outputs map + passing expectations → ok", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--expect", "greetingOut=Hi World", "--expect", "greetingOut~=World"], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.outputs).toEqual({ greetingOut: "Hi World" });
    expect(d.expectations).toMatchObject({ total: 2, passed: 2, failed: 0 });
  });

  test("a mismatch → AD_TEST_EXPECTATION_FAILED, exit 1, per-expectation rows", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--expect", "greetingOut=Hello World", "--expect", "greetingOut~=Hi"], { env: ENV });
    expect(r.envelope?.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.envelope?.error?.code).toBe("AD_TEST_EXPECTATION_FAILED");
    const x = (r.envelope?.data as any).expectations;
    expect(x.results.map((e: any) => e.pass)).toEqual([false, true]);
    expect(x.results[0].actual).toBe("Hi World");
  });

  test("a malformed --expect fails before anything runs", async () => {
    wire();
    const r = await runCommand(testCommand, [DRAFT, "--expect", "nooperator"], { env: ENV });
    expect(r.envelope?.error?.code).toBe("INVALID_EXPECTATION");
    expect(ff!.requests).toEqual([]);
  });

  test("--case: inputs and assertions from a test-case file", async () => {
    wire();
    const file = join(scratchDir("ad-test-case"), "case.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "greet.hi.1",
        inputs: { name: "World" },
        assertions: [{ output: "greetingOut", op: "eq", expected: "Hi World" }, { expression: "#{a} eq #{b}" }],
      }),
    );
    const r = await runCommand(testCommand, [DRAFT, "--case", file], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    const req = ff!.requests.find((q) => q.url.endsWith("/chain/test"))!;
    const body = JSON.parse(JSON.parse(req.body!).find(([k]: [string]) => k === "body")[1]);
    expect(JSON.parse(body.jsonDefinition).inputs.find((i: any) => i.fieldCode === "name").testValue).toBe("World");
    expect((r.envelope?.data as any).expectations).toMatchObject({ total: 1, passed: 1, unevaluated: ["#{a} eq #{b}"] });
  });

  test("--case and --inputs are exclusive; a case missing a required input fails", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [DRAFT, "--case", inputs, "--inputs", inputs], { env: ENV });
    expect(r.envelope?.error?.code).toBe("CONFLICTING_FLAGS");
    const file = join(scratchDir("ad-test-case"), "nocase.json");
    writeFileSync(file, JSON.stringify({ name: "x", inputs: {} }));
    const r2 = await runCommand(testCommand, [DRAFT, "--case", file], { env: ENV });
    expect(r2.envelope?.error?.code).toBe("MISSING_INPUT");
  });
});

describe("ad test input files: stable error codes (was UNHANDLED_EXCEPTION)", () => {
  test.each([
    ["missing file", null, "FILE_NOT_FOUND"],
    ["invalid JSON", "{nope", "INVALID_JSON"],
    ["not an object", "[1]", "INVALID_INPUTS"],
    ["missing required input", "{}", "MISSING_INPUT"],
  ])("--inputs: %s → %s", async (_label, content, errCode) => {
    wire();
    const file = join(scratchDir("ad-test-inputs"), "in.json");
    if (content !== null) writeFileSync(file, content);
    const r = await runCommand(testCommand, [DRAFT, "--inputs", content === null ? `${file}.missing` : file], { env: ENV });
    expect(r.envelope?.error?.code).toBe(errCode);
    expect(ff!.requests.filter((q) => q.url.endsWith("/chain/test"))).toEqual([]);
  });

  test("--case: missing file / invalid JSON", async () => {
    wire();
    const dir = scratchDir("ad-test-case-err");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{nope");
    expect((await runCommand(testCommand, [DRAFT, "--case", join(dir, "none.json")], { env: ENV })).envelope?.error?.code).toBe("FILE_NOT_FOUND");
    expect((await runCommand(testCommand, [DRAFT, "--case", bad], { env: ENV })).envelope?.error?.code).toBe("INVALID_JSON");
  });
});

describe("ad test: a FAILED execution (ADW-R12)", () => {
  test("exits 1 with AD_TEST_FAILED and keeps the run data", async () => {
    const inputs = wire({ failed: true });
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs], { env: ENV });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("AD_TEST_FAILED");
    expect(r.exitCode).not.toBe(0);
    expect((r.envelope?.data as any).status).toBe("FAILED");
  });

  test("a failed expectation still wins over the execution failure", async () => {
    const inputs = wire({ failed: true });
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--expect", "greetingOut=nope"], { env: ENV });
    expect(r.envelope?.error?.code).toBe("AD_TEST_EXPECTATION_FAILED");
  });
});

describe("ad test --compare-published (7.12)", () => {
  test("draft uuid: runs both, diffs the outputs", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--compare-published", "--yes"], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    const c = (r.envelope?.data as any).compare;
    expect(c).toMatchObject({
      draftUuid: DRAFT,
      publishedUuid: PUB,
      identical: false,
      differences: [{ output: "greetingOut", draft: "Hi World", published: "Hello World" }],
      draft: { status: "SUCCESS" },
      published: { status: "SUCCESS", outputs: { greetingOut: "Hello World" } },
    });
    expect(ff!.requests.filter((q) => q.url.endsWith("/chain/test")).map(testedUuid)).toEqual([DRAFT, PUB]);
  });

  test("published uuid: the draft is the main run; expectations decide on the draft, published is informational", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [PUB, "--inputs", inputs, "--compare-published", "--yes", "--expect", "greetingOut=Hello World"], { env: ENV });
    expect(r.envelope?.error?.code).toBe("AD_TEST_EXPECTATION_FAILED");
    const d = r.envelope?.data as any;
    expect(d.outputs).toEqual({ greetingOut: "Hi World" });
    expect(d.compare.published.expectations).toMatchObject({ passed: 1, failed: 0 });
  });

  test("ADW-R14: the second (published) execution needs confirmation; --llm without --yes runs nothing", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--compare-published"], { env: ENV });
    expect(r.envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(ff!.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(0);
  });

  test("a method without a counterpart → AD_NO_PUBLISHED_COUNTERPART", async () => {
    const inputs = wire();
    const body = load("draft.v1.json");
    body.referenceId = null;
    ff!.restore();
    ff = fakeFetch([
      { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: body },
      { method: "GET", url: /\/rest\/api\/automations\/(\d+)/, response: () => JSON.parse(readFileSync(join(FIX, "definitions", "976.json"), "utf8")) },
    ]).install();
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--compare-published"], { env: ENV });
    expect(r.envelope?.error?.code).toBe("AD_NO_PUBLISHED_COUNTERPART");
  });
});

describe("lib/test-run helpers", () => {
  test("outputsMap reads every method output", () => {
    expect(outputsMap(load("test-published.json"))).toEqual({ greetingOut: "Hello World" });
    expect(outputsMap({ outputs: [{ code: "j", testResult: '{"a":1}' }, { outputCode: "b", testResult: "x" }] })).toEqual({ j: { a: 1 }, b: "x" });
  });

  test("diffOutputs ignores key order, reports missing outputs", () => {
    expect(diffOutputs({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual([]);
    expect(diffOutputs({ a: 1 }, { b: 1 })).toEqual([
      { output: "a", draft: 1, published: undefined },
      { output: "b", draft: undefined, published: 1 },
    ]);
  });

  test("counterpart: draft→referenceId, published→referenceId, none", () => {
    expect(counterpart({ state: "DRAFT", uuid: DRAFT, referenceId: ` ${PUB.toUpperCase()} ` } as any)).toEqual({ draftUuid: DRAFT, publishedUuid: PUB });
    expect(counterpart({ state: "PUBLISHED", uuid: PUB, referenceId: DRAFT } as any)).toEqual({ draftUuid: DRAFT, publishedUuid: PUB });
    expect(counterpart({ state: "DRAFT", uuid: DRAFT, referenceId: null } as any)).toBeNull();
  });
});

// CLI trial: `ad test` took only `--inputs <file>` (in --llm), while
// `test-case create` takes `--input k=v` and `ad run` inline JSON.
describe("ad test --input k=v and inline --inputs JSON", () => {
  const posted = () => ff!.requests.find((q) => q.method === "POST")!.body ?? "";

  test("--input name=World runs with that value", async () => {
    wire();
    const r = await runCommand(testCommand, [DRAFT, "--input", "name=World", "--expect", "greetingOut=Hi World"], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    expect(posted()).toContain("World");
  });

  test("inline JSON --inputs, with --input on top", async () => {
    wire();
    const r = await runCommand(testCommand, [DRAFT, "--inputs", '{"name":"Mars"}', "--input", "name=World"], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    expect(posted()).toContain("World");
    expect(posted()).not.toContain("Mars");
  });

  test("an unknown key is INVALID_INPUT; nothing given in --llm names --input", async () => {
    wire();
    const bad = await runCommand(testCommand, [DRAFT, "--input", "nope=1"], { env: ENV });
    expect(bad.envelope?.error?.code).toBe("INVALID_INPUT");
    expect(ff!.requests.filter((q) => q.method === "POST")).toHaveLength(0);
    const none = await runCommand(testCommand, [DRAFT], { env: ENV });
    expect(none.envelope?.error?.code).toBe("INTERACTIVE_NOT_SUPPORTED");
    expect(none.envelope?.error?.message).toContain("--input");
    const badJson = await runCommand(testCommand, [DRAFT, "--inputs", "{nope"], { env: ENV });
    expect(badJson.envelope?.error?.code).toBe("INVALID_JSON");
  });
});
