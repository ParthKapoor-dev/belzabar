// `ad test-case run-suite --wait`: run a method's persisted test cases now,
// one /chain/test run each, and evaluate their assertions locally.
//
// Why not poll the server's own suite run (live 2026-09-29,
// belz_tst_fixt2_idx with one passing and one failing case):
//   - POST /chain/testsuite/execute answers at once with "…you will receive an
//     email with an execution report";
//   - GET /chain/testsuite/report stays {testsCompleted:0, testsRemaining:0,
//     results:null} before, during and after that run (it is not per chain);
//   - the suite's executionStatus was PASS before the run and stayed PASS with
//     a failing assertion, and no case carries a status of its own.
// So the platform exposes no chain-scoped completion or per-case result; wi-impl
// produces both itself, the same way `ad test --case` does.

import { evaluateExpectations, expectationFromAssertion, isStructured, type Expectation, type ExpectationResult } from "./expect";
import type { SuiteSnapshot } from "./suite";
import { runInlineTest, type FailedStep } from "../test-run";
import type { HydratedMethod } from "../types/common";

type CaseStatus = "PASS" | "FAIL" | "ERROR";

interface CaseRunResult {
  id: string;
  name: string;
  /** PASS: ran and every evaluated assertion held. FAIL: an assertion failed. ERROR: the execution failed (or could not start). */
  status: CaseStatus;
  execution: "SUCCESS" | "FAILED" | null;
  outputs: Record<string, unknown>;
  assertions: { total: number; passed: number; failed: number; results: ExpectationResult[] };
  /** Assertions wi-impl cannot evaluate locally (not `#{out} op literal`). */
  unevaluated: string[];
  failedStep?: FailedStep | null;
  error?: string;
}

export interface SuiteRunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  cases: CaseRunResult[];
}

export async function runSuiteCases(method: HydratedMethod, suite: SuiteSnapshot): Promise<SuiteRunSummary> {
  const cases: CaseRunResult[] = [];
  for (const c of suite.cases) {
    const expectations: Expectation[] = [];
    const unevaluated: string[] = [];
    for (const a of c.file.assertions) {
      if (isStructured(a)) expectations.push(expectationFromAssertion(a));
      else unevaluated.push(a.expression ?? "(no expression)");
    }
    const base = { id: c.id, name: c.file.name, unevaluated };
    try {
      const run = await runInlineTest(method, c.file.inputs);
      const results = evaluateExpectations(run.outputs, expectations);
      const passed = results.filter((r) => r.pass).length;
      const status: CaseStatus = !run.success ? "ERROR" : passed < results.length ? "FAIL" : "PASS";
      const row: CaseRunResult = {
        ...base,
        status,
        execution: run.status,
        outputs: run.outputs,
        assertions: { total: results.length, passed, failed: results.length - passed, results },
      };
      if (!run.success) row.failedStep = run.failedStep;
      cases.push(row);
    } catch (err) {
      cases.push({
        ...base,
        status: "ERROR",
        execution: null,
        outputs: {},
        assertions: { total: expectations.length, passed: 0, failed: 0, results: [] },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const count = (s: CaseStatus) => cases.filter((c) => c.status === s).length;
  return { total: cases.length, passed: count("PASS"), failed: count("FAIL"), errored: count("ERROR"), cases };
}
