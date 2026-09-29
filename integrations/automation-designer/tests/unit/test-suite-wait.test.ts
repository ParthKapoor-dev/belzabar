// CLI trial tr2: `ad test-case run-suite` gave no way to observe completion and
// `ad test-report` answered all zeros (read as "nothing happened").
// Live sems-dev 2026-09-29 (belz_tst_fixt2_idx, one passing + one failing case):
// /testsuite/execute returns at once ("you will receive an email"), the report
// route stays {testsCompleted:0, testsRemaining:0, results:null}, and the
// suite's executionStatus stays PASS with a failing assertion. So:
//   - run-suite --wait runs every active case now (one /chain/test each) and
//     evaluates the assertions: per-case PASS/FAIL/ERROR, exit 1 unless all pass;
//   - run-suite without --wait says it is not observable (data.hint);
//   - test-report says found:false + note instead of bare zeros.
// Real wire: fixtures/test-cases (belz_tst_s7c_t1 draft + its 3-case suite).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { fakeFetch, respond, runCommand, withTempEnvConfig, type FakeFetch, type RecordedRequest, type TempEnvConfig } from "@belzabar/core/testing";
import testCaseCommand from "../../commands/test-case/index";
import testReportCommand, { reportFound } from "../../commands/test-report/index";

const FIX = join(import.meta.dir, "../fixtures");
const DRAFT = "4252b87e4d77d2a6e8f59325550558ae";
const load = (f: string) => JSON.parse(readFileSync(join(FIX, "test-cases", f), "utf8"));
const ENV = "t-tr2-suite";

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

/** The `name` test value a /chain/test POST ran with. */
function testedName(req: RecordedRequest): string {
  const entries = JSON.parse(req.body ?? "[]") as Array<[string, string]>;
  const inner = JSON.parse(JSON.parse(entries.find(([k]) => k === "body")![1]).jsonDefinition);
  return String(inner.inputs.find((i: any) => i.fieldCode === "name").testValue);
}

/** A /chain/test answer whose greetingOut is `greet(name)`; `null` = HTTP 400. */
function wire(greet: (name: string) => string | null) {
  cfg = withTempEnvConfig({ envs: { [ENV]: { url: "https://t-dev.test" } }, activeEnv: ENV });
  spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
  ff = fakeFetch([
    { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: load("draft.v1.json") },
    { method: "GET", url: `/rest/api/automation/chain/testsuite/service-chain/${DRAFT}`, response: load("suite.json") },
    { method: "GET", url: /\/rest\/api\/automations\/(\d+)/, response: () => JSON.parse(readFileSync(join(FIX, "definitions", "976.json"), "utf8")) },
    {
      method: "POST",
      url: "/rest/api/automation/chain/test",
      response: (req: RecordedRequest) => {
        const out = greet(testedName(req));
        if (out === null) return respond({ status: 400, json: { message: "boom" } });
        const body = load("test-draft.json");
        body.services[0].outputs[0].testResult = out;
        body.outputs[0].testResult = out;
        return body;
      },
    },
    { method: "POST", url: "/rest/api/automation/chain/testsuite/execute", response: { result: "The test suite execution has been initiated successfully. You will receive an email with an execution report." } },
    { method: "GET", url: "/rest/api/automation/chain/testsuite/report", response: { testsCompleted: 0, testsRemaining: 0, secondsElapsed: 0, results: null, resultsPending: null } },
  ]).install();
}

describe("ad test-case run-suite --wait", () => {
  test("every case passes → ok, per-case rows, never the async execute route", async () => {
    wire((n) => `Hello ${n}`);
    const r = await runCommand(testCaseCommand, ["run-suite", DRAFT, "--wait", "--yes"], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d).toMatchObject({ action: "run-suite", mode: "wait", chainUuid: DRAFT, total: 3, passed: 3, failed: 0, errored: 0 });
    expect(d.cases.map((c: any) => c.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(d.cases[0].assertions).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(ff!.requests.filter((q) => q.url.endsWith("/chain/test"))).toHaveLength(3);
    expect(ff!.requests.some((q) => q.url.includes("/testsuite/execute"))).toBe(false);
  });

  test("a failing assertion and a failed execution → AD_TESTCASE_SUITE_FAILED, exit 1, FAIL/ERROR rows", async () => {
    wire((n) => (n === "Mars" ? "Hi Mars" : n === "World" ? null : `Hello ${n}`));
    const r = await runCommand(testCaseCommand, ["run-suite", DRAFT, "--wait", "--yes"], { env: ENV });
    expect(r.envelope?.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.envelope?.error?.code).toBe("AD_TESTCASE_SUITE_FAILED");
    const d = r.envelope?.data as any;
    expect(d).toMatchObject({ total: 3, passed: 1, failed: 1, errored: 1 });
    const by = Object.fromEntries(d.cases.map((c: any) => [c.name, c]));
    expect(by["belz_tst_s7c_t1.greet.mars.2"].status).toBe("FAIL");
    expect(by["belz_tst_s7c_t1.greet.mars.2"].assertions.results[0].actual).toBe("Hi Mars");
    expect(by["belz_tst_s7c_t1.greet.ok.1"].status).toBe("ERROR");
    expect(by["belz_tst_s7c_t1.greet.ok.1"].error).toContain("boom");
    expect(by["belz_tst_s7c_t1.greet.quote.1"].status).toBe("PASS");
  });

  test("--wait is a write: --llm without --yes is refused before anything runs", async () => {
    wire((n) => `Hello ${n}`);
    const r = await runCommand(testCaseCommand, ["run-suite", DRAFT, "--wait"], { env: ENV });
    expect(r.envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(ff!.requests.some((q) => q.url.endsWith("/chain/test"))).toBe(false);
  });

  test("without --wait: the async run, with a hint that it is not observable", async () => {
    wire((n) => `Hello ${n}`);
    const r = await runCommand(testCaseCommand, ["run-suite", DRAFT, "--yes"], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.response.result).toContain("email");
    expect(d.hint).toContain("--wait");
  });
});

describe("ad test-report", () => {
  test("all zeros → found:false with a note, not a bare report", async () => {
    wire((n) => `Hello ${n}`);
    const r = await runCommand(testReportCommand, [], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.found).toBe(false);
    expect(d.note).toContain("not scoped to a method");
    expect(d.report.testsCompleted).toBe(0);
  });

  test("reportFound", () => {
    expect(reportFound(null)).toBe(false);
    expect(reportFound({ testsCompleted: 0, testsRemaining: 0, results: null, resultsPending: null })).toBe(false);
    expect(reportFound({ testsCompleted: 0, testsRemaining: 2, results: null })).toBe(true);
    expect(reportFound({ testsCompleted: 0, testsRemaining: 0, results: [{ a: 1 }] })).toBe(true);
  });
});
