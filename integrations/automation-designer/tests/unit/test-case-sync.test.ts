// test cases as git-friendly files, fetch-back verified writes,
// export and sync — over the real acme-dev suite of belz_tst_s7c_t1
// (fixtures/test-cases/suite.json) and an in-memory fake of the suite store
// that mimics the live server: PUT keeps name/description, DELETE is soft and
// reserves the name, jsonb values come back re-spaced.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { jsonFixtures, type RecordedRequest, respond, runCommand, scratchDir } from "@belzabar/core/testing";
import testCaseCommand from "../../commands/test-case/index";
import { caseFromWire, caseToWire, diffCases, parseCaseInput, serializeCaseFile } from "../../lib/test-cases/case-file";
import { planSync, type SuiteSnapshot } from "../../lib/test-cases/suite";
import { writeMethodDir, readCaseFiles } from "../../lib/test-cases/files";
import { fakeAdEnv } from "./helpers/fake-ad";

const FIX = join(import.meta.dir, "../fixtures/test-cases");
const DRAFT = "4252b87e4d77d2a6e8f59325550558ae";
const load = jsonFixtures(FIX);
const ENV = "t-s7c";

const ad = fakeAdEnv({ env: ENV });
afterEach(() => ad.restore());

// ── fake suite store ─────────────────────────────────────────────────────

interface StoredCase {
  id: string;
  name: string;
  description: string;
  inputs: Array<Record<string, unknown>>;
  assertions: Array<Record<string, unknown>>;
  active: boolean;
}

/** jsonb round-trip: the server re-serialises `{"value":"x"}` as `{"value": "x"}`. */
const jsonb = (v: unknown) => (typeof v === "string" ? JSON.stringify(JSON.parse(v), null, 1).replace(/\n\s*/g, " ").replace(/\{ /g, "{").replace(/ \}/g, "}") : v);

/** `initial: null` = a method with no suite yet: the suite GET answers 200 + EMPTY body (live acme-dev). */
function fakeServer(initial: any = load("suite.json")) {
  let n = 0;
  const cases: StoredCase[] = (initial?.testCases ?? []).map((c: any) => ({ ...c, active: true }));
  const store = (body: any, id: string): Pick<StoredCase, "inputs" | "assertions"> => ({
    inputs: (body.inputs ?? []).map((i: any) => ({ id: `in${++n}`, testCaseId: id, fieldCode: i.fieldCode, value: jsonb(i.value), defaultValue: jsonb(i.defaultValue) })),
    assertions: (body.assertions ?? []).map((a: any) => ({ id: `as${++n}`, testCaseId: id, mode: a.mode, conditionExpression: a.conditionExpression })),
  });
  const routes = [
    {
      method: "GET",
      url: `/rest/api/automation/chain/testsuite/service-chain/${DRAFT}`,
      response: () =>
        initial === null && cases.length === 0
          ? respond({ status: 200, text: "" })
          : { ...(initial ?? { id: "suite-new", active: true }), testCases: cases.filter((c) => c.active) },
    },
    { method: "GET", url: `/rest/api/automation/chain/v2/${DRAFT}`, response: load("draft.v2.json") },
    {
      method: "POST",
      url: `/rest/api/automation/chain/testcases/${DRAFT}`,
      response: (req: RecordedRequest) => {
        const body = req.json();
        // live: a name over 96 characters is a bare 500
        if ([...body.name].length > 96) return respond({ status: 500, json: { errorMessage: "An error has occurred at server side" } });
        if (cases.some((c) => c.name === body.name)) {
          return respond({ status: 400, json: { errorMessage: "TestCase name should be unique" } });
        }
        const id = `tc${++n}`;
        const c: StoredCase = { id, name: body.name, description: body.description ?? "", active: body.active !== false, ...store(body, id) };
        cases.push(c);
        return c;
      },
    },
    {
      method: "PUT",
      url: new RegExp(`/rest/api/automation/chain/testcases/${DRAFT}/(\\w+)$`),
      response: (req: RecordedRequest) => {
        const id = /\/(\w+)$/.exec(req.url)![1]!;
        const c = cases.find((x) => x.id === id)!;
        const body = req.json();
        Object.assign(c, store(body, id)); // name/description/active are NOT persisted (live)
        return { ...c, name: body.name, description: body.description };
      },
    },
    {
      method: "DELETE",
      url: /\/rest\/api\/automation\/chain\/testcases\/(\w+)$/,
      response: (req: RecordedRequest) => {
        const id = /\/(\w+)$/.exec(req.url)![1]!;
        cases.find((x) => x.id === id)!.active = false; // soft delete: the name stays taken
        return respond({ status: 200, text: "" });
      },
    },
  ];
  return { routes, cases };
}

function wire(server = fakeServer()) {
  ad.install(server.routes);
  return server;
}

const run = (argv: string[]) => runCommand(testCaseCommand, argv, { env: ENV });

// ── case file encoding ───────────────────────────────────────────────────

describe("case file ↔ wire", () => {
  const suite = load("suite.json");

  test("real suite decodes to env-free case files (jsonb re-spacing ignored)", () => {
    const files = suite.testCases.map(caseFromWire);
    const quote = files.find((f: any) => f.name.endsWith("quote.1"));
    expect(quote).toEqual({
      name: "belz_tst_s7c_t1.greet.quote.1",
      description: "quote in name",
      inputs: { name: "O'Brien" },
      // the infix `contains` earlier versions stored scores ERROR on the server: it reads back raw
      assertions: [{ expression: "#{greetingOut} contains 'O''Brien'" }],
    });
    for (const f of files) expect(JSON.stringify(f)).not.toMatch(/"id"|createdOn|testSuiteId/);
  });

  test("wire → file → wire → file is stable", () => {
    for (const w of suite.testCases) {
      const f = caseFromWire(w);
      expect(diffCases(caseFromWire(caseToWire(f)), f)).toEqual([]);
      expect(caseToWire(f)).toMatchObject({ name: w.name, description: w.description });
    }
  });

  test("UI encoding: {\"value\": …} wrapper in value and defaultValue", () => {
    const w = caseToWire({ name: "n", description: "", inputs: { b: 5, a: { x: [1] } }, assertions: [{ output: "o", op: "eq", expected: "x" }] });
    expect(w.inputs).toEqual([
      { fieldCode: "a", value: '{"value":{"x":[1]}}', defaultValue: '{"value":{"x":[1]}}' },
      { fieldCode: "b", value: '{"value":5}', defaultValue: '{"value":5}' },
    ]);
    expect(w.assertions).toEqual([{ mode: "advance", conditionExpression: "#{o} eq 'x'", conditions: null }]);
  });

  test("wrapper extras, differing defaults and legacy bare values survive", () => {
    const wireCase = {
      name: "x",
      inputs: [
        { fieldCode: "obj", value: '{"value": {"k": 1}, "properties": [{"value": []}]}' },
        { fieldCode: "d", value: '{"value": 1}', defaultValue: '{"value": 2}' },
        { fieldCode: "bare", value: "plain" },
      ],
      assertions: [],
    };
    const f = caseFromWire(wireCase);
    expect(f.inputs).toEqual({ bare: "plain", d: 1, obj: { k: 1 } });
    expect(f.inputExtras).toEqual({ bare: { raw: true }, d: { defaultValue: 2 }, obj: { wrapper: { properties: [{ value: [] }] } } });
    expect(diffCases(caseFromWire(caseToWire(f)), f)).toEqual([]);
  });

  test("serialized file: fixed top-level order, sorted nested keys, newline", () => {
    const text = serializeCaseFile({ name: "n", description: "d", inputs: { z: { b: 1, a: 2 }, a: 1 }, assertions: [{ expected: 1, op: "eq", output: "o" } as any] });
    expect(text).toBe(
      `{\n  "name": "n",\n  "description": "d",\n  "inputs": {\n    "a": 1,\n    "z": {\n      "a": 2,\n      "b": 1\n    }\n  },\n  "assertions": [\n    {\n      "output": "o",\n      "op": "eq",\n      "expected": 1\n    }\n  ]\n}\n`,
    );
  });

  test("parseCaseInput: active:false and unknown keys are refused", () => {
    expect(() => parseCaseInput({ name: "a", active: false, inputs: {} }, "f")).toThrow(expect.objectContaining({ code: "AD_TESTCASE_INVALID" }));
    expect(() => parseCaseInput({ name: "a", input: {} }, "f")).toThrow(/unknown key/);
    expect(() => parseCaseInput({ name: "a", assertions: [{ output: "o", op: "ge", expected: 1 }] }, "f")).toThrow(/op must be/);
  });

  // K12
  test("parseCaseInput: notContains, and a list or {} with eq / neq; a non-empty object is refused", () => {
    const c = parseCaseInput(
      { name: "a", assertions: [{ output: "o", op: "notContains", expected: "x" }, { output: "l", op: "eq", expected: ["a"] }, { output: "m", op: "neq", expected: {} }] },
      "f",
    );
    expect((caseToWire(c).assertions as Array<{ conditionExpression: string }>).map((a) => a.conditionExpression)).toEqual([
      "#{o.toString()}.contains('x') eq false",
      `#{l.toString()} eq '["a"]'`,
      "#{m.toString()} ne '{}'",
    ]);
    expect(() => parseCaseInput({ name: "a", assertions: [{ output: "m", op: "eq", expected: { k: 1 } }] }, "f")).toThrow(/Java map/);
    expect(() => parseCaseInput({ name: "a", assertions: [{ output: "l", op: "contains", expected: [] }] }, "f")).toThrow(/= or != only/);
  });
});

describe("planSync", () => {
  const suite: SuiteSnapshot = {
    chainUuid: DRAFT,
    testSuiteId: "s",
    cases: [
      { id: "1", file: { name: "a", description: "", inputs: { x: 1 }, assertions: [] } },
      { id: "2", file: { name: "b", description: "old", inputs: { x: 1 }, assertions: [] } },
      { id: "3", file: { name: "c", description: "", inputs: { x: 1 }, assertions: [] } },
      { id: "4", file: { name: "d", description: "", inputs: {}, assertions: [] } },
      { id: "5", file: { name: "d", description: "", inputs: {}, assertions: [] } },
      { id: "6", file: { name: "e", description: "", inputs: {}, assertions: [] } },
    ],
  };
  const files = [
    { name: "a", description: "", inputs: { x: 1 }, assertions: [] },
    { name: "b", description: "new", inputs: { x: 1 }, assertions: [] },
    { name: "c", description: "new", inputs: { x: 2 }, assertions: [] },
    { name: "d", description: "", inputs: {}, assertions: [] },
    { name: "n", description: "", inputs: {}, assertions: [] },
  ];

  test("create / update / drift / conflict / extra", () => {
    const plan = planSync(files, suite, false);
    expect(plan.map((p) => [p.action, p.name])).toEqual([
      ["unchanged", "a"],
      ["drift", "b"],
      ["update", "c"],
      ["conflict", "d"],
      ["create", "n"],
      ["extra", "e"],
    ]);
    expect(plan.find((p) => p.name === "c")?.changes).toEqual(["description", "inputs"]);
  });

  test("--prune turns extra into delete", () => {
    expect(planSync(files, suite, true).find((p) => p.name === "e")?.action).toBe("delete");
  });
});

// ── commands ─────────────────────────────────────────────────────────────

describe("test-case create --assert (fetch-back verified)", () => {
  test("flags → UI-encoded body; the suite is re-read and compared", async () => {
    wire();
    const r = await run(["create", DRAFT, "--name", "t.greet.new.1", "--description", "d", "--input", "name=007", "--assert", "greetingOut=Hello 007", "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    const post = ad.ff.requests.find((q) => q.method === "POST")!.json();
    expect(post).toEqual({
      name: "t.greet.new.1",
      description: "d",
      inputs: [{ fieldCode: "name", value: '{"value":"007"}', defaultValue: '{"value":"007"}' }], // STRING input keeps the text
      assertions: [{ mode: "advance", conditionExpression: "#{greetingOut} eq 'Hello 007'", conditions: null }],
    });
    expect(r.envelope?.data).toMatchObject({ action: "create", verified: true, checks: [{ name: "t.greet.new.1", verified: true, mismatched: [] }] });
    // A12: the new case's id at the top level
    expect((r.envelope?.data as any).id).toBe((r.envelope?.data as any).checks[0].id);
    expect((r.envelope?.data as any).id).toMatch(/^tc\d+$/);
  });

  // A12: preview the stored SpEL without writing.
  test("--dry-run returns the body it would POST and writes nothing", async () => {
    wire();
    const r = await run(["create", DRAFT, "--name", "t.dry.1", "--input", "name=x", "--assert", "greetingOut!=x", "--assert", "greetingOut~=ell", "--dry-run"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ action: "create", dryRun: true, name: "t.dry.1" });
    expect((r.envelope?.data as any).body.assertions.map((a: any) => a.conditionExpression)).toEqual([
      "#{greetingOut} ne 'x'",
      "#{greetingOut.toString()}.contains('ell') eq true",
    ]);
    expect(ad.ff.requests.filter((q) => q.method !== "GET")).toEqual([]);
    // still refuses an existing name
    const taken = await run(["create", DRAFT, "--name", "belz_tst_s7c_t1.greet.ok.1", "--dry-run"]);
    expect(taken.envelope?.error?.code).toBe("AD_TESTCASE_EXISTS");
    const w = (testCaseCommand as any).writes as (a: any) => boolean;
    expect(w({ action: "create", dryRun: true })).toBe(false);
  });

  test("a store that drops a field fails verification", async () => {
    const server = fakeServer();
    const post = server.routes.find((x) => x.method === "POST")!;
    const orig = post.response as (req: RecordedRequest) => any;
    post.response = (req: RecordedRequest) => {
      const c = orig(req);
      c.assertions = []; // lost on the way
      return c;
    };
    wire(server);
    const r = await run(["create", DRAFT, "--name", "t.lost.1", "--input", "name=x", "--assert", "greetingOut=Hello x", "--yes"]);
    expect(r.envelope?.error?.code).toBe("AD_TESTCASE_VERIFY_FAILED");
    expect((r.envelope?.data as any).checks[0].mismatched).toEqual(["assertions"]);
  });

  test("an existing name, an unknown input or output are refused before any write", async () => {
    for (const [argv, code] of [
      [["--name", "belz_tst_s7c_t1.greet.ok.1"], "AD_TESTCASE_EXISTS"],
      [["--name", "x", "--input", "nmae=1"], "AD_TESTCASE_CONTRACT"],
      [["--name", "x", "--assert", "greeting=1"], "AD_TESTCASE_CONTRACT"],
    ] as const) {
      wire();
      const r = await run(["create", DRAFT, ...argv, "--yes"]);
      expect(r.envelope?.error?.code).toBe(code);
      expect(ad.ff.requests.filter((q) => q.method !== "GET")).toEqual([]);
      ad.restore();
    }
  });

  test("a name reserved by a deleted case → AD_TESTCASE_NAME_RESERVED", async () => {
    const server = fakeServer();
    server.cases.push({ id: "gone", name: "t.deleted.1", description: "", inputs: [], assertions: [], active: false });
    wire(server);
    const r = await run(["create", DRAFT, "--name", "t.deleted.1", "--yes"]);
    expect(r.envelope?.error?.code).toBe("AD_TESTCASE_NAME_RESERVED");
  });

  test("--assert with an unsupported shape is a parse error", async () => {
    wire();
    const r = await run(["create", DRAFT, "--name", "x", "--assert", "a>=1"]);
    expect(r.envelope?.error?.code).toBe("INVALID_ASSERTION");
  });
});

describe("test-case update", () => {
  const okCase = () => load("suite.json").testCases.find((c: any) => c.name.endsWith("ok.1"));
  const putBody = () => ad.ff.requests.find((q) => q.method === "PUT")!.json();

  test("PUT replaces inputs/assertions and is verified", async () => {
    wire();
    const r = await run(["update", DRAFT, okCase().id, "--input", "name=Venus", "--assert", "greetingOut=Hello Venus", "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ id: okCase().id, checks: [{ verified: true }] });
  });

  // A11: a file without "description" meant "set it to empty", which was refused.
  test("--file without a description keeps the current one", async () => {
    wire();
    const dir = scratchDir("tc-upd-nodesc");
    writeFileSync(join(dir, "c.json"), JSON.stringify({ name: okCase().name, inputs: { name: "x" }, assertions: [] }));
    const r = await run(["update", DRAFT, okCase().id, "--file", join(dir, "c.json"), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).descriptionKept).toBeUndefined();
    expect(r.envelope?.meta?.warnings).toBeUndefined();
    expect(putBody().description).toBe(okCase().description);
  });

  test("another description: the rest is updated, the description kept with a warning", async () => {
    const server = wire();
    const dir = scratchDir("tc-upd-desc");
    writeFileSync(join(dir, "c.json"), JSON.stringify({ name: okCase().name, description: "new text", inputs: { name: "x" } }));
    const r = await run(["update", DRAFT, okCase().id, "--file", join(dir, "c.json"), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ verified: true, descriptionKept: { requested: "new text", current: okCase().description } });
    expect(String(r.envelope?.meta?.warnings)).toContain("create the case under a new name");
    expect(server.cases.find((c) => c.id === okCase().id)!.inputs[0]!.value).toBe('{"value": "x"}');
  });

  test("another name is refused before any write", async () => {
    wire();
    const dir = scratchDir("tc-upd-name");
    writeFileSync(join(dir, "c.json"), JSON.stringify({ name: "other.name", inputs: { name: "x" } }));
    const r = await run(["update", DRAFT, okCase().id, "--file", join(dir, "c.json"), "--yes"]);
    expect(r.envelope?.error?.code).toBe("AD_TESTCASE_FIELD_NOT_UPDATABLE");
    expect(ad.ff.requests.some((q) => q.method === "PUT")).toBe(false);
  });
});

// A14: after a migration a method keeps its uuid and case ids on every env, so a
// delete must say which env, method and suite it touched.
describe("test-case delete", () => {
  const ok1 = () => load("suite.json").testCases.find((c: any) => c.name.endsWith("ok.1"));

  test("data names the env; with --uuid also the method, suite and case", async () => {
    const server = wire();
    const mars = load("suite.json").testCases.find((c: any) => c.name.endsWith("mars.2")).id;
    const plain = await run(["delete", mars, "--yes"]);
    expect(plain.envelope?.data).toEqual({ action: "delete", env: ENV, testCaseId: mars, response: { deleted: mars } });
    ad.restore();

    wire(server);
    const r = await run(["delete", ok1().id, "--uuid", DRAFT, "--yes"]);
    expect(r.envelope?.data).toMatchObject({ action: "delete", env: ENV, chainUuid: DRAFT, method: "belz_tst_s7c_t1", testSuiteId: load("suite.json").id, name: ok1().name });
    expect(server.cases.find((c) => c.id === ok1().id)!.active).toBe(false);
  });

  test("--uuid with a case that is not in that suite deletes nothing", async () => {
    wire();
    const r = await run(["delete", "not-there", "--uuid", DRAFT, "--yes"]);
    expect(r.envelope?.error?.code).toBe("AD_TESTCASE_NOT_FOUND");
    expect(ad.ff.requests.some((q) => q.method === "DELETE")).toBe(false);
  });
});

describe("test-case bulk", () => {
  test("posts one fully encoded case per entry (the bulk route only takes string maps)", async () => {
    wire();
    const dir = scratchDir("tc-bulk");
    const f = join(dir, "cases.json");
    writeFileSync(f, JSON.stringify([
      { name: "b.1", inputs: { name: "A" }, assertions: [{ output: "greetingOut", op: "eq", expected: "Hello A" }] },
      { name: "b.2", inputs: [{ fieldCode: "name", value: '{"value":"B"}' }], assertions: [] },
    ]));
    const r = await run(["bulk", DRAFT, "--file", f, "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(ad.ff.requests.filter((q) => q.method === "POST").map((q) => q.url)).toEqual([
      `https://t-dev.test/rest/api/automation/chain/testcases/${DRAFT}`,
      `https://t-dev.test/rest/api/automation/chain/testcases/${DRAFT}`,
    ]);
    expect((r.envelope?.data as any).checks.map((c: any) => c.verified)).toEqual([true, true]);
  });
});

// K11: a name over 96 characters got a bare HTTP 500 (bulk: the whole batch failed).
describe("test-case name length", () => {
  const name = (n: number) => `k11.${"x".repeat(n)}`.slice(0, n);
  const posts = () => ad.ff.requests.filter((q) => q.method === "POST");

  test("create: 96 characters are posted, 97 are refused before any write", async () => {
    wire();
    expect((await run(["create", DRAFT, "--name", name(96), "--input", "name=x", "--yes"])).envelope?.ok).toBe(true);
    ad.restore();
    wire();
    const r = await run(["create", DRAFT, "--name", name(97), "--input", "name=x", "--yes"]);
    expect(r.envelope?.error?.code).toBe("AD_TESTCASE_NAME_TOO_LONG");
    expect(r.envelope?.error?.message).toContain("(97)");
    expect(r.envelope?.error?.message).toContain("at most 96");
    expect(posts()).toEqual([]);
  });

  test("bulk names the long case and posts none", async () => {
    wire();
    const f = join(scratchDir("tc-bulk-long"), "cases.json");
    writeFileSync(f, JSON.stringify([{ name: "ok.1", inputs: { name: "A" } }, { name: name(108), inputs: { name: "B" } }]));
    const r = await run(["bulk", DRAFT, "--file", f, "--yes"]);
    expect(r.envelope?.error?.code).toBe("AD_TESTCASE_NAME_TOO_LONG");
    expect(r.envelope?.error?.details).toEqual({ max: 96, names: [{ name: name(108), length: 108 }] });
    expect(posts()).toEqual([]);
  });

  test("sync refuses a long name in its files, dry run included", async () => {
    wire();
    const dir = join(scratchDir("tc-sync-long"), "m");
    mkdirSync(join(dir, "cases"), { recursive: true });
    writeFileSync(join(dir, "method.json"), JSON.stringify({ name: "belz_tst_s7c_t1", uuids: { [ENV]: DRAFT } }));
    writeFileSync(join(dir, "cases", "0.json"), JSON.stringify({ name: name(100), inputs: { name: "r" } }));
    for (const argv of [["sync", dir], ["sync", dir, "--apply", "--yes"]]) {
      expect((await run(argv)).envelope?.error?.code).toBe("AD_TESTCASE_NAME_TOO_LONG");
    }
    expect(posts()).toEqual([]);
  });

  test("characters are counted, not bytes", async () => {
    wire();
    expect((await run(["create", DRAFT, "--name", `${name(95)}é`, "--input", "name=x", "--yes"])).envelope?.ok).toBe(true);
  });
});

describe("test-case export / sync", () => {
  test("export writes <root>/<Category>/<method>/{method.json, cases/*.json}; re-export is a no-op", async () => {
    wire();
    const root = scratchDir("tc-export");
    const r = await run(["export", DRAFT, "--dir", root]);
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.methodDir).toBe(join(root, "Test-Tester", "belz_tst_s7c_t1"));
    expect(JSON.parse(readFileSync(join(d.methodDir, "method.json"), "utf8"))).toEqual({
      name: "belz_tst_s7c_t1",
      category: "Test-Tester",
      uuids: { [ENV]: DRAFT },
      inputs: { name: "STRING" },
      outputs: ["greetingOut"],
    });
    expect(readdirSync(join(d.methodDir, "cases")).sort()).toEqual([
      "belz_tst_s7c_t1.greet.mars.2.json",
      "belz_tst_s7c_t1.greet.ok.1.json",
      "belz_tst_s7c_t1.greet.quote.1.json",
    ]);
    const again = await run(["export", DRAFT, "--dir", root]);
    expect((again.envelope?.data as any).files.written).toEqual([]);
    // export is read-only on the server
    expect(ad.ff.requests.every((q) => q.method === "GET")).toBe(true);
  });

  // A13: without --dir, export printed a MISSING_DIR envelope that `> backup.json` saved as the backup.
  test("export without --dir prints the suite JSON itself; bulk --file takes it back", async () => {
    wire();
    const human = await runCommand(testCaseCommand, ["export", DRAFT], { env: ENV, llm: false });
    expect(human.exitCode).toBe(0);
    const backup = JSON.parse(human.stdout);
    expect(backup).toMatchObject({ action: "export", chainUuid: DRAFT, env: ENV, total: 3, method: { name: "belz_tst_s7c_t1", uuids: { [ENV]: DRAFT } } });
    expect(backup.cases.map((c: any) => c.name)).toContain("belz_tst_s7c_t1.greet.ok.1");
    expect(ad.ff.requests.every((q) => q.method === "GET")).toBe(true);
    // an explicit --llm keeps the envelope, with the same data
    const llm = await run(["export", DRAFT]);
    expect(llm.envelope?.data).toEqual(backup);
    expect((testCaseCommand as any).humanByDefault({ action: "export" })).toBe(true);
    expect((testCaseCommand as any).humanByDefault({ action: "export", dir: "x" })).toBe(false);
    ad.restore();

    // restore onto a method with no suite
    const server = wire(fakeServer(null));
    const f = join(scratchDir("tc-backup"), "backup.json");
    writeFileSync(f, human.stdout);
    const restored = await run(["bulk", DRAFT, "--file", f, "--yes"]);
    expect(restored.envelope?.ok).toBe(true);
    expect(server.cases.map((c) => c.name).sort()).toEqual(backup.cases.map((c: any) => c.name).sort());
  });

  test("export --prune without --dir is refused", async () => {
    wire();
    const r = await run(["export", DRAFT, "--prune"]);
    expect(r.envelope?.error?.code).toBe("INVALID_ARGUMENT");
  });

  test("sync: dry run plans, --apply writes and verifies, a second plan is clean", async () => {
    const server = wire();
    const root = scratchDir("tc-sync");
    const dir = (await run(["export", DRAFT, "--dir", root])).envelope!.data as any;
    const cases = join(dir.methodDir, "cases");
    const ok1 = join(cases, "belz_tst_s7c_t1.greet.ok.1.json");
    const edited = JSON.parse(readFileSync(ok1, "utf8"));
    edited.inputs.name = "Pluto";
    edited.assertions[0].expected = "Hello Pluto";
    edited.description = "local wording";
    writeFileSync(ok1, JSON.stringify(edited));
    writeFileSync(join(cases, "new.json"), JSON.stringify({ name: "t.new.1", inputs: { name: "N" }, assertions: [] }));
    const writesBefore = ad.ff.requests.filter((q) => q.method !== "GET").length;

    const dry = await run(["sync", dir.methodDir]);
    expect(dry.envelope?.ok).toBe(true);
    expect((dry.envelope?.data as any).counts).toEqual({ unchanged: 2, update: 1, create: 1 });
    expect(ad.ff.requests.filter((q) => q.method !== "GET").length).toBe(writesBefore);

    const applied = await run(["sync", dir.methodDir, "--apply", "--yes"]);
    expect(applied.envelope?.ok).toBe(true);
    expect((applied.envelope?.data as any).verified).toBe(true);
    expect(server.cases.find((c) => c.name.endsWith("ok.1"))!.inputs[0]!.value).toBe('{"value": "Pluto"}');

    const again = await run(["sync", dir.methodDir]);
    expect((again.envelope?.data as any).counts).toEqual({ unchanged: 3, drift: 1 });
  });

  /** A method dir holding only these case files. */
  function methodDir(tag: string, cases: Array<Record<string, unknown>>): string {
    const dir = join(scratchDir(tag), "m");
    mkdirSync(join(dir, "cases"), { recursive: true });
    writeFileSync(join(dir, "method.json"), JSON.stringify({ name: "belz_tst_s7c_t1", uuids: { [ENV]: DRAFT } }));
    cases.forEach((c, i) => writeFileSync(join(dir, "cases", `${i}.json`), JSON.stringify(c)));
    return dir;
  }

  test("sync --prune deletes server-only cases", async () => {
    const server = wire();
    const r = await run(["sync", methodDir("tc-prune-ok", [{ name: "t.new.1", inputs: { name: "r" } }]), "--apply", "--prune", "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(server.cases.filter((c) => c.active).map((c) => c.name)).toEqual(["t.new.1"]);
  });

  // A19: the deletes ran although a create failed on a name a deleted case holds, leaving the suite short.
  test("a create that fails (reserved name) → no delete runs; the dry run says reserved names cannot be seen", async () => {
    const server = fakeServer();
    server.cases.push({ id: "gone", name: "t.reserved.1", description: "", inputs: [], assertions: [], active: false });
    wire(server);
    const dir = methodDir("tc-prune", [{ name: "t.reserved.1", inputs: { name: "r" } }]);
    const dry = await run(["sync", dir, "--prune"]);
    expect((dry.envelope?.data as any).notes[0]).toContain("cannot be seen in advance");
    const r = await run(["sync", dir, "--apply", "--prune", "--yes"]);
    expect(r.envelope?.error?.code).toBe("AD_TESTCASE_SYNC_FAILED");
    const plan = (r.envelope?.data as any).plan;
    expect(plan.find((p: any) => p.action === "create").error.code).toBe("AD_TESTCASE_NAME_RESERVED");
    const deletes = plan.filter((p: any) => p.action === "delete");
    expect(deletes).toHaveLength(3);
    expect(deletes.map((p: any) => p.error.code)).toEqual(["AD_TESTCASE_SYNC_SKIPPED", "AD_TESTCASE_SYNC_SKIPPED", "AD_TESTCASE_SYNC_SKIPPED"]);
    expect(ad.ff.requests.some((q) => q.method === "DELETE")).toBe(false);
    expect(server.cases.filter((c) => c.active)).toHaveLength(3);
  });

  // A17: stale inputs (no longer on the method) blocked restoring cases with sync.
  test("--drop-unknown-inputs leaves out inputs the method no longer has; the contract error suggests it", async () => {
    const server = wire();
    const okName = "belz_tst_s7c_t1.greet.ok.1";
    const stale = { name: okName, inputs: { name: "Stale", removedInput: "x" }, assertions: [{ output: "greetingOut", op: "eq", expected: "Hello Stale" }] };
    const dir = methodDir("tc-drop", [stale]);
    const refused = await run(["sync", dir, "--apply", "--yes"]);
    expect(refused.envelope?.error?.code).toBe("AD_TESTCASE_CONTRACT");
    expect(refused.envelope?.error?.message).toContain("--drop-unknown-inputs");
    const r = await run(["sync", dir, "--apply", "--drop-unknown-inputs", "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ verified: true, droppedInputs: [{ case: okName, key: "removedInput" }], problems: [] });
    const put = ad.ff.requests.find((q) => q.method === "PUT")!.json();
    expect(put.inputs.map((i: any) => i.fieldCode)).toEqual(["name"]);
    expect(server.cases.find((c) => c.name === okName)!.inputs.map((i) => i.fieldCode)).toEqual(["name"]);
    // the file itself is not changed
    expect(JSON.parse(readFileSync(join(dir, "cases", "0.json"), "utf8")).inputs.removedInput).toBe("x");
  });

  // A18: a STRING/TEXT input holding "{}" runs as that text, not as "no value".
  test("a text input holding \"{}\" is warned about on create, export and sync (raw {} is not)", async () => {
    wire();
    const c = await run(["create", DRAFT, "--name", "t.braces.1", "--input", "name={}", "--yes"]);
    expect(c.envelope?.ok).toBe(true);
    expect((c.envelope?.data as any).warnings).toEqual([{ case: "t.braces.1", kind: "text-input-braces", key: "name" }]);
    expect(String(c.envelope?.meta?.warnings)).toContain('not as "no value"');
    const e = await run(["export", DRAFT]);
    expect((e.envelope?.data as any).warnings).toEqual([{ case: "t.braces.1", kind: "text-input-braces", key: "name" }]);
    expect(String(e.envelope?.meta?.warnings)).toContain("t.braces.1: 'name'");
    const dir = methodDir("tc-braces", [{ name: "t.braces.1", inputs: { name: "{}" } }]);
    const sync = await run(["sync", dir]);
    expect((sync.envelope?.data as any).problems).toEqual([{ case: "t.braces.1", kind: "text-input-braces", key: "name" }]);
    ad.restore();

    // the platform's raw {} ("no value") is not text: no warning
    const server = fakeServer();
    server.cases[0]!.inputs = [{ id: "i", fieldCode: "name", value: "{}", defaultValue: "{}" }];
    wire(server);
    const raw = await run(["export", DRAFT]);
    expect((raw.envelope?.data as any).warnings).toEqual([]);
  });

  // A22: a description-only change was reported as synced.
  test("a different description is reported as not synced, with a warning", async () => {
    wire();
    const ok1 = load("suite.json").testCases.find((x: any) => x.name.endsWith("ok.1"));
    const file = { ...caseFromWire(ok1), description: "new wording" };
    const r = await run(["sync", methodDir("tc-desc", [file]), "--apply", "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ applied: false, counts: { drift: 1 }, descriptionNotApplied: [ok1.name] });
    expect(String(r.envelope?.meta?.warnings)).toContain("give the case a new name");
    expect(ad.ff.requests.some((q) => q.method !== "GET")).toBe(false);
  });

  test("sync without a uuid for the env fails clearly", async () => {
    wire();
    const dir = join(scratchDir("tc-nouuid"), "m");
    mkdirSync(join(dir, "cases"), { recursive: true });
    writeFileSync(join(dir, "method.json"), JSON.stringify({ name: "x", uuids: { "other-env": DRAFT } }));
    const r = await run(["sync", dir]);
    expect(r.envelope?.error?.code).toBe("AD_TESTCASE_NO_UUID");
  });

  test("writes: export and a dry-run sync are reads; --apply is a write", () => {
    const w = (testCaseCommand as any).writes as (a: any) => boolean;
    expect(w({ action: "export" })).toBe(false);
    expect(w({ action: "sync", apply: false })).toBe(false);
    expect(w({ action: "sync", apply: true })).toBe(true);
    expect(w({ action: "create" })).toBe(true);
    expect(w({ action: "list" })).toBe(false);
  });
});

describe("files", () => {
  test("stale case files are reported, and removed only with prune; renamed files keep their path", () => {
    const dir = join(scratchDir("tc-files"), "m");
    const meta = { name: "m", category: "C", uuids: {}, inputs: {}, outputs: [] };
    writeMethodDir(dir, meta, [{ name: "a", description: "", inputs: {}, assertions: [] }, { name: "b", description: "", inputs: {}, assertions: [] }], false);
    // someone renamed a.json → my-a.json: the name inside decides
    const a = join(dir, "cases", "a.json");
    writeFileSync(join(dir, "cases", "my-a.json"), readFileSync(a, "utf8"));
    require("fs").rmSync(a);
    const res = writeMethodDir(dir, meta, [{ name: "a", description: "x", inputs: {}, assertions: [] }], false);
    expect(res.written).toContain(join(dir, "cases", "my-a.json"));
    expect(existsSync(a)).toBe(false);
    expect(res.stale).toEqual([join(dir, "cases", "b.json")]);
    const pruned = writeMethodDir(dir, meta, [{ name: "a", description: "x", inputs: {}, assertions: [] }], true);
    expect(pruned.removed).toEqual([join(dir, "cases", "b.json")]);
    expect(readCaseFiles(dir).map((c) => c.file.name)).toEqual(["a"]);
  });

  test("duplicate case names across files are an error", () => {
    const dir = join(scratchDir("tc-dupe"), "m");
    mkdirSync(join(dir, "cases"), { recursive: true });
    writeFileSync(join(dir, "cases", "1.json"), JSON.stringify({ name: "same" }));
    writeFileSync(join(dir, "cases", "2.json"), JSON.stringify({ name: "same" }));
    expect(() => readCaseFiles(dir)).toThrow(expect.objectContaining({ code: "AD_TESTCASE_DUPLICATE_NAME" }));
  });
});

// ── a method with no suite yet (200 + empty body crashed every action) ──

describe("no suite yet: the suite GET answers 200 with an empty body", () => {
  test("list and export are empty, not UNHANDLED_EXCEPTION", async () => {
    wire(fakeServer(null));
    const list = await run(["list", DRAFT]);
    expect(list.envelope?.ok).toBe(true);
    expect(list.envelope?.data).toMatchObject({ action: "list", testSuiteId: null, total: 0, testCases: [] });
    const dir = scratchDir("tc-empty");
    const exp = await run(["export", DRAFT, "--dir", dir]);
    expect(exp.envelope?.ok).toBe(true);
    expect((exp.envelope?.data as any).total).toBe(0);
  });

  test("create makes the first case (the POST creates the suite) and verifies it", async () => {
    const server = wire(fakeServer(null));
    const r = await run(["create", DRAFT, "--name", "t.first.1", "--input", "name=x", "--assert", "greetingOut=Hello x", "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ action: "create", verified: true });
    expect(server.cases.map((c) => c.name)).toEqual(["t.first.1"]);
  });
});
