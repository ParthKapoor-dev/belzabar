// `ad test --expect`, `--case` and `--compare-published` over the
// real acme-dev bodies of belz_tst_s7c_t1 (fixtures/test-cases: draft
// 4252b87e… whose echo was changed to "Hi #{name}", and its published copy
// 4725bcfb… still saying "Hello #{name}") and the real /chain/test answers.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { CliError } from "@belzabar/core";
import { jsonFixtures, type RecordedRequest, runCommand, scratchDir } from "@belzabar/core/testing";
import testCommand from "../../commands/test/index";
import { counterpart, diffOutputs, outputsMap } from "../../lib/test-run";
import { definitionRoute, fakeAdEnv } from "./helpers/fake-ad";

const FIX = join(import.meta.dir, "../fixtures");
const DRAFT = "4252b87e4d77d2a6e8f59325550558ae";
const PUB = "4725bcfbb9d1e3c7eeb489dc0293d96a";
const load = jsonFixtures(join(FIX, "test-cases"));
const ENV = "t-s7c-test";

const ad = fakeAdEnv({ env: ENV });
afterEach(() => ad.restore());

/** The multipart /chain/test body's `uuid`: which chain a test POST ran. */
function testedUuid(req: RecordedRequest): string {
  const entries = JSON.parse(req.body ?? "[]") as Array<[string, string]>;
  return JSON.parse(entries.find(([k]) => k === "body")![1]).uuid;
}

function wire(opts: { failed?: boolean } = {}) {
  ad.install([
    { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: load("draft.v1.json") },
    { method: "GET", url: `/rest/api/automation/chain/${PUB}`, response: load("published.v1.json") },
    definitionRoute(),
    {
      method: "POST",
      url: "/rest/api/automation/chain/test",
      response: (req: RecordedRequest) => {
        const body = testedUuid(req) === PUB ? load("test-published.json") : load("test-draft.json");
        if (opts.failed) body.executionStatus.failed = true;
        return body;
      },
    },
  ]);
  const inputs = join(scratchDir("ad-test-expect"), "in.json");
  writeFileSync(inputs, JSON.stringify({ name: "World" }));
  return inputs;
}

describe("ad test --expect", () => {
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
    expect(ad.ff.requests).toEqual([]);
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
    // an assertion wi-impl cannot evaluate leaves the case NOT CHECKED: never ok:true
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("AD_TEST_NOT_CHECKED");
    const req = ad.ff.requests.find((q) => q.url.endsWith("/chain/test"))!;
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
    expect(ad.ff.requests.filter((q) => q.url.endsWith("/chain/test"))).toEqual([]);
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

describe("ad test: a FAILED execution", () => {
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

describe("ad test --compare-published", () => {
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
    expect(ad.ff.requests.filter((q) => q.url.endsWith("/chain/test")).map(testedUuid)).toEqual([DRAFT, PUB]);
  });

  test("published uuid: the draft is the main run; expectations decide on the draft, published is informational", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [PUB, "--inputs", inputs, "--compare-published", "--yes", "--expect", "greetingOut=Hello World"], { env: ENV });
    expect(r.envelope?.error?.code).toBe("AD_TEST_EXPECTATION_FAILED");
    const d = r.envelope?.data as any;
    expect(d.outputs).toEqual({ greetingOut: "Hi World" });
    expect(d.compare.published.expectations).toMatchObject({ passed: 1, failed: 0 });
  });

  test("the second (published) execution needs confirmation; --llm without --yes runs nothing", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--compare-published"], { env: ENV });
    expect(r.envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(ad.ff.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(0);
  });

  test("a method without a counterpart → AD_NO_PUBLISHED_COUNTERPART", async () => {
    const inputs = wire();
    const body = load("draft.v1.json");
    body.referenceId = null;
    ad.install([
      { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: body },
      definitionRoute(),
    ]);
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

// `ad test` took only `--inputs <file>` (in --llm), while
// `test-case create` takes `--input k=v` and `ad run` inline JSON.
describe("ad test --input k=v and inline --inputs JSON", () => {
  const posted = () => ad.ff.requests.find((q) => q.method === "POST")!.body ?? "";

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
    expect(ad.ff.requests.filter((q) => q.method === "POST")).toHaveLength(0);
    const none = await runCommand(testCommand, [DRAFT], { env: ENV });
    expect(none.envelope?.error?.code).toBe("INTERACTIVE_NOT_SUPPORTED");
    expect(none.envelope?.error?.message).toContain("--input");
    const badJson = await runCommand(testCommand, [DRAFT, "--inputs", "{nope"], { env: ENV });
    expect(badJson.envelope?.error?.code).toBe("INVALID_JSON");
  });
});

describe("ad test --cases: a table of input cases", () => {
  function casesFile(name: string, text: string): string {
    const file = join(scratchDir("ad-test-cases"), name);
    writeFileSync(file, text);
    return file;
  }
  const posts = () => ad.ff.requests.filter((r) => r.method === "POST").length;

  test("JSONL: one execution per case, per-case pass/fail, AD_TEST_CASES_FAILED when any fails", async () => {
    wire();
    const file = casesFile(
      "cases.jsonl",
      [
        JSON.stringify({ name: "ok", inputs: { name: "World" }, expect: ["greetingOut=Hi World"] }),
        JSON.stringify({ inputs: { name: "Bob" }, expect: ["greetingOut=Hi Bob"] }),
      ].join("\n"),
    );
    const r = await runCommand(testCommand, [DRAFT, "--cases", file, "--expect", "greetingOut~=Hi", "--yes"], { env: ENV });
    expect(r.envelope?.error?.code).toBe("AD_TEST_CASES_FAILED");
    expect(r.exitCode).not.toBe(0);
    const d = r.envelope?.data as any;
    expect(d.summary).toEqual({ total: 2, passed: 1, failed: 1, toolErrors: 0 });
    expect(d.cases.map((c: any) => [c.name, c.pass])).toEqual([["ok", true], ["case 2", false]]);
    // the common --expect runs after each case's own
    expect(d.cases[1].expectations.map((e: any) => e.pass)).toEqual([false, true]);
    expect(posts()).toBe(2);
  });

  test("JSON array, all pass → ok; a FAILED execution fails its case", async () => {
    wire();
    const file = casesFile("cases.json", JSON.stringify([{ name: "a", inputs: { name: "World" } }]));
    const r = await runCommand(testCommand, [DRAFT, "--cases", file, "--yes"], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).summary).toEqual({ total: 1, passed: 1, failed: 0, toolErrors: 0 });
    ad.restore();
    wire({ failed: true });
    const f = await runCommand(testCommand, [DRAFT, "--cases", file, "--yes"], { env: ENV });
    expect(f.envelope?.error?.code).toBe("AD_TEST_CASES_FAILED");
    expect((f.envelope?.data as any).cases[0].status).toBe("FAILED");
  });

  test("--llm without --yes runs nothing; a bad row fails before any execution", async () => {
    wire();
    const good = casesFile("good.json", JSON.stringify([{ inputs: { name: "World" } }]));
    const r = await runCommand(testCommand, [DRAFT, "--cases", good], { env: ENV, llm: true });
    expect(r.envelope?.ok).toBe(false);
    expect(posts()).toBe(0);
    const missing = casesFile("missing.json", JSON.stringify([{ inputs: { name: "World" } }, { name: "empty", inputs: {} }]));
    const m = await runCommand(testCommand, [DRAFT, "--cases", missing, "--yes"], { env: ENV });
    expect(m.envelope?.error?.code).toBe("MISSING_INPUT");
    const bad = casesFile("bad.json", JSON.stringify([{ inputs: { name: "x" }, expect: ["nooperator"] }]));
    expect((await runCommand(testCommand, [DRAFT, "--cases", bad, "--yes"], { env: ENV })).envelope?.error?.code).toBe("INVALID_EXPECTATION");
    const notObj = casesFile("notobj.json", "[1]");
    expect((await runCommand(testCommand, [DRAFT, "--cases", notObj, "--yes"], { env: ENV })).envelope?.error?.code).toBe("INVALID_CASES");
    expect(posts()).toBe(0);
  });

  test("--cases cannot be combined with --inputs, --case or --repeat", async () => {
    wire();
    for (const extra of [["--inputs", "{}"], ["--case", "x.json"], ["--repeat", "3"]]) {
      const r = await runCommand(testCommand, [DRAFT, "--cases", "c.json", ...extra], { env: ENV });
      expect(r.envelope?.error?.code).toBe("CONFLICTING_FLAGS");
    }
  });

  test("--cases --compare-published: each case on the draft then the published copy, one row per case (B3)", async () => {
    wire();
    const file = casesFile("cmp.jsonl", [JSON.stringify({ name: "w", inputs: { name: "World" } }), JSON.stringify({ name: "b", inputs: { name: "Bob" } })].join("\n"));
    const r = await runCommand(testCommand, [DRAFT, "--cases", file, "--compare-published", "--yes"], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.publishedUuid).toBe(PUB);
    expect(d.summary).toEqual({ total: 2, passed: 2, failed: 0, toolErrors: 0, identical: 0, different: 2 });
    expect(d.cases[0].compare).toMatchObject({
      identical: false,
      mismatches: ["outputs"],
      differences: [{ output: "greetingOut", draft: "Hi World", published: "Hello World" }],
      published: { status: "SUCCESS", outputs: { greetingOut: "Hello World" } },
    });
    // draft first, then published, case by case
    expect(ad.ff.requests.filter((q) => q.url.endsWith("/chain/test")).map(testedUuid)).toEqual([DRAFT, PUB, DRAFT, PUB]);
  });

  test("progress goes to stderr, one line per case; --trace adds each case's trace (B6)", async () => {
    wire();
    const file = casesFile("p.json", JSON.stringify([{ name: "one", inputs: { name: "World" } }, { name: "two", inputs: { name: "Bob" } }]));
    const r = await runCommand(testCommand, [DRAFT, "--cases", file, "--yes", "--trace"], { env: ENV, quiet: false } as any);
    expect(r.stderr).toMatch(/case 1\/2 PASS one \(\d+\.\ds\)/);
    expect(r.stderr).toContain("case 2/2 PASS two");
    const d = r.envelope?.data as any;
    expect(Array.isArray(d.cases[0].trace)).toBe(true);
    expect(d.cases[0].timing).toBeDefined();
    const noTrace = await runCommand(testCommand, [DRAFT, "--cases", file, "--yes"], { env: ENV });
    expect((noTrace.envelope?.data as any).cases[0].trace).toBeUndefined();
  });

  test("an auth error is retried once; a second one is a tool error, counted apart (B11)", async () => {
    let calls = 0;
    ad.install([
      { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: load("draft.v1.json") },
      definitionRoute(),
      {
        method: "POST",
        url: "/rest/api/automation/chain/test",
        response: () => {
          calls++;
          // case 1: first try fails (retried, then passes); case 2: both tries fail
          if (calls === 1 || calls === 3 || calls === 4) throw new CliError("login succeeded but no token was found", { code: "AUTH_NO_TOKEN" });
          return load("test-draft.json");
        },
      },
    ]);
    const file = casesFile("auth.json", JSON.stringify([{ name: "a", inputs: { name: "World" } }, { name: "b", inputs: { name: "World" } }]));
    const r = await runCommand(testCommand, [DRAFT, "--cases", file, "--yes"], { env: ENV });
    const d = r.envelope?.data as any;
    expect(d.cases[0]).toMatchObject({ pass: true, retried: true });
    expect(d.cases[1]).toMatchObject({ pass: false, status: "ERROR", retried: true, error: { code: "AUTH_NO_TOKEN", tool: true } });
    expect(d.summary).toEqual({ total: 2, passed: 1, failed: 1, toolErrors: 1 });
    expect(r.envelope?.error?.message).toContain("1 of them are tool errors");
    expect(calls).toBe(4);
  });
});

describe("ad test --compare-published: what is compared (B4)", () => {
  /** The draft body's test answer with its status / failing step / outputs changed. */
  function wireRuns(draft: (b: any) => void, published: (b: any) => void) {
    ad.install([
      { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: load("draft.v1.json") },
      { method: "GET", url: `/rest/api/automation/chain/${PUB}`, response: load("published.v1.json") },
      definitionRoute(),
      {
        method: "POST",
        url: "/rest/api/automation/chain/test",
        response: (req: RecordedRequest) => {
          const body = load("test-draft.json");
          (testedUuid(req) === PUB ? published : draft)(body);
          return body;
        },
      },
    ]);
  }
  const failAt = (step: number, message: string, statusCode = 500) => (b: any) => {
    b.executionStatus = { failed: true, statusCode };
    b.services = b.services.map((s: any, i: number) => (i === step - 1 ? { ...s, executionStatus: { executed: false, failed: true, statusCode, message } } : s));
    for (const o of b.outputs) delete o.testResult;
  };
  const setOut = (v: string) => (b: any) => {
    b.outputs[0].testResult = v;
  };
  const compare = async (...extra: string[]) =>
    (await runCommand(testCommand, [DRAFT, "--input", "name=World", "--compare-published", "--yes", ...extra], { env: ENV })).envelope?.data as any;

  test("failing at different steps with empty outputs is not identical", async () => {
    wireRuns(failAt(1, "boom"), (b) => {
      failAt(1, "other error")(b);
    });
    const c = (await compare()).compare;
    expect(c.identical).toBe(false);
    expect(c.mismatches).toEqual(["failedStep"]);
  });

  test("both failing the same way: identical, partial outputs not compared", async () => {
    wireRuns(failAt(1, "boom"), (b) => {
      failAt(1, "boom")(b);
      b.outputs[0].testResult = "[]";
    });
    const c = (await compare()).compare;
    expect(c).toMatchObject({ identical: true, outputsCompared: false, differences: [] });
  });

  test("a different HTTP status is a difference", async () => {
    wireRuns(failAt(1, "denied", 403), failAt(1, "denied", 422));
    expect((await compare()).compare.mismatches).toEqual(["statusCode"]);
  });

  test("--ignore-order and --ignore <path>", async () => {
    wireRuns(setOut('[{"id":1,"updatedAt":"a"},{"id":2,"updatedAt":"b"}]'), setOut('[{"id":2,"updatedAt":"c"},{"id":1,"updatedAt":"d"}]'));
    expect((await compare()).compare.identical).toBe(false);
    expect((await compare("--ignore-order")).compare.identical).toBe(false);
    const both = await compare("--ignore-order", "--ignore", "greetingOut[].updatedAt");
    expect(both.compare).toMatchObject({ identical: true, ignored: { paths: ["greetingOut[].updatedAt"], order: true } });
    expect((await compare("--ignore-order", "--ignore", "*.updatedAt")).compare.identical).toBe(true);
    expect((await compare("--ignore", "greetingOut")).compare.identical).toBe(true);
  });

  test("the published side carries its trace and timing; the draft ran first", async () => {
    wireRuns(() => {}, () => {});
    const c = (await compare()).compare;
    expect(c.order).toEqual(["draft", "published"]);
    expect(Array.isArray(c.published.trace)).toBe(true);
    expect(c.published.timing).toBeDefined();
    expect(c.draft.timing).toBeDefined();
  });

  test("--ignore without --compare-published, or a bad path, is refused before anything runs", async () => {
    wire();
    expect((await runCommand(testCommand, [DRAFT, "--input", "name=x", "--ignore-order"], { env: ENV })).envelope?.error?.code).toBe("MISSING_FLAG");
    expect((await runCommand(testCommand, [DRAFT, "--compare-published", "--ignore", "a..b"], { env: ENV })).envelope?.error?.code).toBe("INVALID_IGNORE_PATH");
    expect(ad.ff.requests.filter((q) => q.method === "POST")).toEqual([]);
  });
});

describe("ad test --repeat (B20)", () => {
  test("runs N times and reports min / median / max", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--repeat", "3", "--yes"], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    const rep = (r.envelope?.data as any).repeat;
    expect(rep.runs).toBe(3);
    expect(rep.wallMs.values).toHaveLength(3);
    expect(rep.wallMs.min).toBeLessThanOrEqual(rep.wallMs.median);
    expect(ad.ff.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(3);
  });

  test("needs --yes in --llm; not with --compare-published", async () => {
    const inputs = wire();
    const r = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--repeat", "2"], { env: ENV, llm: true });
    expect(r.envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(ad.ff.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(0);
    const c = await runCommand(testCommand, [DRAFT, "--inputs", inputs, "--repeat", "2", "--compare-published"], { env: ENV });
    expect(c.envelope?.error?.code).toBe("CONFLICTING_FLAGS");
  });
});
