import { readFile } from "fs/promises";
import { CliError, defineArgs, failWithData, ok, type CommandModule, type OutputMode } from "@belzabar/core";
import { InputCollector } from "../../lib/input-collector";
import { adApi } from "../../lib/api/index";
import { resolveMethodRef } from "@belzabar/core/platform";
import { AD_YES_FLAG } from "../../lib/args/common";
import { requireConfirmation } from "../../lib/args/confirm";
import {
  counterpart,
  diffOutputs,
  runInlineTest,
  type FailedStep,
  type OutputDifference,
  type ServiceResult,
  type ServiceTraceRow,
  type TestRun,
} from "../../lib/test-run";
import {
  evaluateExpectations,
  expectationFromAssertion,
  isStructured,
  parseExpectation,
  type Expectation,
  type ExpectationResult,
} from "../../lib/test-cases/expect";
import { parseCaseInput } from "../../lib/test-cases/case-file";
import { caseFailure, readCases, resolveCaseInputs, runCases, type CaseResult, type CasesSummary } from "../../lib/test-cases/cases-table";
import type { HydratedMethod } from "../../lib/types/common";

export { matchStep } from "../../lib/test-run";

interface TestMethodArgs {
  uuid: string;
  inputsFile?: string;
  inputPairs: string[];
  caseFile?: string;
  casesFile?: string;
  expect: string[];
  comparePublished: boolean;
  yes: boolean;
  verbose: boolean;
  raw: boolean;
}

interface ExpectationBlock {
  total: number;
  passed: number;
  failed: number;
  results: ExpectationResult[];
  /** Case-file assertions belz cannot evaluate locally (not `#{out} op literal`). */
  unevaluated?: string[];
}

interface CompareBlock {
  draftUuid: string;
  publishedUuid: string;
  /** Same status and the same value for every output. */
  identical: boolean;
  differences: OutputDifference[];
  draft: { status: TestRun["status"] };
  published: {
    status: TestRun["status"];
    outputs: Record<string, unknown>;
    failedStep: FailedStep | null;
    /** The same expectations evaluated on the published run (informational). */
    expectations?: ExpectationBlock;
  };
}

/** `--cases`: one row per case. */
interface TestCasesData {
  uuid: string;
  cases: CaseResult[];
  summary: CasesSummary;
}

interface TestMethodData {
  uuid: string;
  verbosity: "normal" | "verbose";
  success: boolean;
  status: "SUCCESS" | "FAILED";
  output: unknown;
  parsedOutput: unknown;
  /** Every method output: code → value. */
  outputs: Record<string, unknown>;
  failedStep: FailedStep | null;
  trace: ServiceTraceRow[];
  serviceResults: ServiceResult[];
  expectations?: ExpectationBlock;
  compare?: CompareBlock;
  raw?: {
    executionResult: unknown;
    publishedExecutionResult?: unknown;
  };
}

export const args = defineArgs({
  command: "belz ad test",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: {
    ...AD_YES_FLAG,
    inputs: { type: "string" },
    input: { type: "string", repeatable: true },
    case: { type: "string" },
    cases: { type: "string" },
    expect: { type: "string", repeatable: true },
    "compare-published": { type: "boolean" },
    // A command flag, not the runner's debug switch: declared here so
    // the runner hands `--verbose`/`-v` to this command.
    verbose: { type: "boolean", alias: ["-v"] },
    raw: { type: "boolean" },
  },
  exclusive: [["inputs", "case", "cases"], ["cases", "compare-published"]],
});

function block(results: ExpectationResult[], unevaluated: string[] = []): ExpectationBlock {
  const passed = results.filter((r) => r.pass).length;
  const b: ExpectationBlock = { total: results.length, passed, failed: results.length - passed, results };
  if (unevaluated.length > 0) b.unevaluated = unevaluated;
  return b;
}

async function loadCase(path: string): Promise<{ values: Record<string, unknown>; expectations: Expectation[]; unevaluated: string[] }> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new CliError(`Cannot read test case ${path}: ${(err as Error).message}`, { code: "FILE_NOT_FOUND", details: { path } });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new CliError(`Test case ${path} is not valid JSON: ${(err as Error).message}`, { code: "INVALID_JSON", details: { path } });
  }
  const c = parseCaseInput(json, path);
  const expectations: Expectation[] = [];
  const unevaluated: string[] = [];
  for (const a of c.assertions) {
    if (isStructured(a)) expectations.push(expectationFromAssertion(a));
    else unevaluated.push(a.expression ?? "(no expression)");
  }
  return { values: c.inputs, expectations, unevaluated };
}

function requireInputs(method: HydratedMethod, values: Record<string, unknown>, source: string): void {
  const missing = method.inputs.filter((i) => i.required && !i.hideInput && values[i.code] === undefined).map((i) => i.code);
  if (missing.length > 0) {
    throw new CliError(`${source} is missing required input(s): ${missing.join(", ")}.`, { code: "MISSING_INPUT" });
  }
}

async function runCaseTable(a: TestMethodArgs, method: HydratedMethod, outputMode: OutputMode) {
  const cases = resolveCaseInputs(method, await readCases(a.casesFile!), a.inputPairs);
  await requireConfirmation({
    yes: a.yes,
    outputMode,
    action: `execute the method ${cases.length} time(s), once per case, with real side effects every time`,
    details: [
      ["Method", `${method.name} (${method.uuid})`],
      ["Cases", String(cases.length)],
    ],
  });
  const { results, summary } = await runCases(method, cases, a.expect.map(parseExpectation));
  const data: TestCasesData = { uuid: method.uuid, cases: results, summary };
  if (summary.failed > 0) {
    const failed = results.filter((r) => !r.pass).map((r) => r.name);
    return failWithData("AD_TEST_CASES_FAILED", `${summary.failed} of ${summary.total} case(s) failed: ${failed.join(", ")}.`, data, { details: { failed } });
  }
  return ok(data);
}

const command: CommandModule<TestMethodArgs, TestMethodData | TestCasesData> = {
  // Executes the chain: SQL/HTTP steps really run (and commit), so an explicit --env is required.
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    // Fail on a malformed --expect before anything runs.
    for (const e of flags.expect) parseExpectation(e);
    return {
      uuid: positionals.uuid,
      inputsFile: flags.inputs,
      inputPairs: flags.input,
      caseFile: flags.case,
      casesFile: flags.cases,
      expect: flags.expect,
      comparePublished: flags.comparePublished,
      yes: flags.yes,
      verbose: flags.verbose,
      raw: flags.raw,
    };
  },
  async execute(a, context) {
    const uuid = resolveMethodRef(a.uuid);
    // V1 fetch: the test body is the fetched definition (test-before-save).
    const given = await adApi.fetchMethod(uuid, "v1");
    if (a.casesFile) return runCaseTable(a, given, context.outputMode);

    let draft = given;
    let published: HydratedMethod | null = null;
    let pair: { draftUuid: string; publishedUuid: string } | null = null;
    if (a.comparePublished) {
      pair = counterpart(given);
      if (!pair) {
        throw new CliError(
          `${given.name} (${uuid}) has no ${given.state === "PUBLISHED" ? "draft" : "published"} counterpart to compare with (state ${given.state}, no referenceId).`,
          { code: "AD_NO_PUBLISHED_COUNTERPART", details: { uuid, state: given.state } },
        );
      }
      const other = await adApi.fetchMethod(given.state === "DRAFT" ? pair.publishedUuid : pair.draftUuid, "v1");
      draft = given.state === "DRAFT" ? given : other;
      published = given.state === "DRAFT" ? other : given;
    }

    let values: Record<string, unknown>;
    let expectations = a.expect.map(parseExpectation);
    let unevaluated: string[] = [];
    if (a.caseFile) {
      const c = await loadCase(a.caseFile);
      values = a.inputPairs.length > 0 ? { ...c.values, ...(await InputCollector.collect(draft.inputs.map((i) => ({ ...i, required: false })), undefined, a.inputPairs)) } : c.values;
      requireInputs(draft, values, a.caseFile);
      expectations = [...c.expectations, ...expectations];
      unevaluated = c.unevaluated;
    } else {
      values = await InputCollector.collect(draft.inputs, a.inputsFile, a.inputPairs);
    }

    if (published && pair) {
      // the published copy runs too, with the same side effects (SQL commits,
      // HTTP calls, e-mails) — through the production body. Confirm it (--yes in --llm).
      await requireConfirmation({
        yes: a.yes,
        outputMode: context.outputMode,
        action: "execute the method TWICE (draft and the PUBLISHED copy), with real side effects both times",
        details: [
          ["Draft UUID", pair.draftUuid],
          ["Published UUID", pair.publishedUuid],
        ],
      });
    }

    const run = await runInlineTest(draft, values);
    const data: TestMethodData = {
      uuid,
      verbosity: a.verbose ? "verbose" : "normal",
      success: run.success,
      status: run.status,
      output: run.output,
      parsedOutput: run.parsedOutput,
      outputs: run.outputs,
      failedStep: run.failedStep,
      trace: run.trace,
      serviceResults: run.serviceResults,
    };
    if (expectations.length > 0 || unevaluated.length > 0) data.expectations = block(evaluateExpectations(run.outputs, expectations), unevaluated);

    if (published && pair) {
      const pub = await runInlineTest(published, values);
      const differences = diffOutputs(run.outputs, pub.outputs);
      data.compare = {
        draftUuid: pair.draftUuid,
        publishedUuid: pair.publishedUuid,
        identical: differences.length === 0 && run.status === pub.status,
        differences,
        draft: { status: run.status },
        published: { status: pub.status, outputs: pub.outputs, failedStep: pub.failedStep },
      };
      if (expectations.length > 0) data.compare.published.expectations = block(evaluateExpectations(pub.outputs, expectations));
      if (a.raw) data.raw = { executionResult: run.executionResult, publishedExecutionResult: pub.executionResult };
    } else if (a.raw) {
      data.raw = { executionResult: run.executionResult };
    }

    if (data.expectations && data.expectations.failed > 0) {
      const failed = data.expectations.results.filter((r) => !r.pass);
      return failWithData(
        "AD_TEST_EXPECTATION_FAILED",
        `${failed.length} of ${data.expectations.total} expectation(s) failed: ${failed.map((r) => `${r.expectation} (${r.reason})`).join("; ")}`,
        data,
        { details: { failed } },
      );
    }
    // a failed execution is a failed command (like `ad run` / `run-suites`), not ok:true.
    if (!run.success) {
      const where = run.failedStep ? ` at step ${run.failedStep.index}: ${run.failedStep.parsedError.summary}` : "";
      return failWithData("AD_TEST_FAILED", `The method execution FAILED${where}.`, data);
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    const raw = envelope.data as TestMethodData | TestCasesData | null;
    if (!raw) return;
    if ("cases" in raw) {
      ui.table(
        ["Case", "Result", "Status", "Failure"],
        raw.cases.map((c) => [c.name, c.pass ? "PASS" : "FAIL", c.status, c.pass ? "" : caseFailure(c)]),
      );
      const s = raw.summary;
      // a failure's summary is the error message the runner prints
      if (s.failed === 0) ui.success(`${s.passed}/${s.total} case(s) passed.`);
      return;
    }
    const data = raw;

    if (data.success) {
      ui.success("Method executed successfully.");
    } else {
      ui.warn("Method execution failed.");
      if (data.failedStep) {
        ui.section("Failed Step");
        ui.table(
          ["Property", "Value"],
          [
            ["Step", data.failedStep.index],
            ["Automation ID", data.failedStep.automationId],
            ["Description", data.failedStep.description],
            ["Summary", data.failedStep.parsedError.summary],
          ],
        );
        ui.text(data.failedStep.parsedError.detail);
      }
    }

    ui.section("Outputs");
    const codes = Object.keys(data.outputs);
    if (codes.length === 0) ui.text("(No Output)");
    else ui.table(["Output", "Value"], codes.map((c) => [c, JSON.stringify(data.outputs[c])]));

    ui.section("Execution Trace");
    ui.table(
      ["Step", "Automation ID", "Description", "Status", "Total Time", "Error"],
      data.trace.map((step) => [step.step, step.automationId, step.description, step.status, step.totalTime, step.errorSummary ?? ""]),
    );

    if (data.verbosity === "verbose") {
      for (const svc of data.serviceResults) {
        ui.section(`Step ${svc.step}: ${svc.description} [${svc.status}]`);
        if (svc.status === "skipped") ui.text("(skipped — condition not met)");
        else if (svc.outputs.length === 0) ui.text("(no outputs)");
        else ui.table(["Output", "Value"], svc.outputs.map((o) => [o.code, JSON.stringify(o.value)]));
      }
    }

    if (data.compare) {
      const c = data.compare;
      ui.section(`Draft vs published (${c.publishedUuid})`);
      if (c.identical) ui.success(`Identical: status ${c.draft.status}, ${Object.keys(data.outputs).length} output(s) equal.`);
      else {
        if (c.draft.status !== c.published.status) ui.warn(`Status differs: draft ${c.draft.status}, published ${c.published.status}.`);
        if (c.differences.length > 0) {
          ui.table(["Output", "Draft", "Published"], c.differences.map((d) => [d.output, JSON.stringify(d.draft), JSON.stringify(d.published)]));
        }
      }
    }

    if (data.expectations) {
      const x = data.expectations;
      ui.section("Expectations");
      for (const r of x.results) {
        if (r.pass) ui.success(`PASS  ${r.expectation}`);
        else ui.error(`FAIL  ${r.expectation}  — ${r.reason}`);
      }
      for (const u of x.unevaluated ?? []) ui.info(`SKIP  ${u} (not evaluated locally)`);
      ui.text(`${x.passed}/${x.total} passed`);
    }

    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
