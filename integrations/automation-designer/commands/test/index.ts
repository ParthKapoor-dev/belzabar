import { readFile } from "fs/promises";
import { CliError, defineArgs, failWithData, ok, printErr, type CommandContext, type CommandModule } from "@belzabar/core";
import { InputCollector } from "../../lib/input-collector";
import { adApi } from "../../lib/api/index";
import { resolveMethodRef } from "@belzabar/core/platform";
import { AD_YES_FLAG } from "../../lib/args/common";
import { requireConfirmation } from "../../lib/args/confirm";
import { compareRuns, parseIgnorePath, type CompareOptions, type RunComparison } from "../../lib/compare-run";
import {
  counterpart,
  runInlineTest,
  type FailedStep,
  type ServiceResult,
  type RunTiming,
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
import { parseCaseInput, runnableInputs } from "../../lib/test-cases/case-file";
import { caseFailure, readCases, resolveCaseInputs, runCases, type CaseResult, type CasesSummary } from "../../lib/test-cases/cases-table";
import {
  asyncSteps,
  calleeDrafts,
  ranVersionOf,
  runWarnings,
  testRouteInputWarnings,
  unpublishedDraftOf,
  writingSteps,
  type RanVersion,
} from "../../lib/run-context";
import { repeatStats, type RepeatStats } from "../../lib/repeat";
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
  ignore: string[];
  ignoreOrder: boolean;
  trace: boolean;
  repeat: number;
  yes: boolean;
  verbose: boolean;
  raw: boolean;
}

interface ExpectationBlock {
  total: number;
  passed: number;
  failed: number;
  results: ExpectationResult[];
  /** Case-file assertions wi-impl cannot evaluate locally (not `#{out} op literal`). */
  unevaluated?: string[];
}

interface CompareBlock extends RunComparison {
  draftUuid: string;
  publishedUuid: string;
  /** The draft runs first, then the published copy (the database then holds both runs' writes). */
  order: ["draft", "published"];
  /** --ignore paths and --ignore-order, as applied. */
  ignored?: { paths: string[]; order: boolean };
  draft: { status: TestRun["status"]; statusCode: number | null; timing: RunTiming };
  published: {
    status: TestRun["status"];
    statusCode: number | null;
    outputs: Record<string, unknown>;
    failedStep: FailedStep | null;
    trace: ServiceTraceRow[];
    timing: RunTiming;
    /** The same expectations evaluated on the published run (informational). */
    expectations?: ExpectationBlock;
  };
}

/** `--cases`: one row per case. */
interface TestCasesData {
  uuid: string;
  /** The copy that ran (a uuid runs its own body): `PUBLISHED v5`. */
  ranVersion: RanVersion;
  /** --compare-published: the published copy each case also ran on, after the draft. */
  publishedUuid?: string;
  cases: CaseResult[];
  summary: CasesSummary;
}

interface TestMethodData {
  uuid: string;
  /** The copy that ran (a uuid runs its own body): `PUBLISHED v5`, `DRAFT v6`. */
  ranVersion: RanVersion;
  verbosity: "normal" | "verbose";
  success: boolean;
  status: "SUCCESS" | "FAILED";
  /** HTTP status of the run (what `ad run` answers: 403 for a refusal); null when the server gives none. */
  statusCode: number | null;
  output: unknown;
  parsedOutput: unknown;
  /** Every method output: code → value. */
  outputs: Record<string, unknown>;
  failedStep: FailedStep | null;
  trace: ServiceTraceRow[];
  serviceResults: ServiceResult[];
  /** Server-side run times in ms (executionTime / totalExecutionTime). */
  timing: RunTiming;
  expectations?: ExpectationBlock;
  compare?: CompareBlock;
  /** --repeat N: every run's times (the rest of data is the first run's). */
  repeat?: { runs: number; serverMs: RepeatStats | null; wallMs: RepeatStats };
  raw?: {
    executionResult: unknown;
    publishedExecutionResult?: unknown;
  };
}

export const args = defineArgs({
  command: "wi-impl ad test",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: {
    ...AD_YES_FLAG,
    inputs: { type: "string" },
    input: { type: "string", repeatable: true },
    case: { type: "string" },
    cases: { type: "string" },
    expect: { type: "string", repeatable: true },
    "compare-published": { type: "boolean" },
    ignore: { type: "string", repeatable: true },
    "ignore-order": { type: "boolean" },
    trace: { type: "boolean" },
    repeat: { type: "number", integer: true, min: 1, max: 100, default: 1 },
    // A command flag, not the runner's debug switch: declared here so
    // the runner hands `--verbose`/`-v` to this command.
    verbose: { type: "boolean", alias: ["-v"] },
    raw: { type: "boolean" },
  },
  exclusive: [["inputs", "case", "cases"], ["cases", "repeat"], ["compare-published", "repeat"]],
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
  return { values: runnableInputs(c), expectations, unevaluated };
}

function requireInputs(method: HydratedMethod, values: Record<string, unknown>, source: string): void {
  const missing = method.inputs.filter((i) => i.required && !i.hideInput && values[i.code] === undefined).map((i) => i.code);
  if (missing.length > 0) {
    throw new CliError(`${source} is missing required input(s): ${missing.join(", ")}.`, { code: "MISSING_INPUT" });
  }
}

/** Say what runs before it runs: the drafts it does not run, its async steps (context warnings). */
async function warnRun(method: HydratedMethod, context: CommandContext): Promise<void> {
  const [own, callees] = await Promise.all([unpublishedDraftOf(method), calleeDrafts(method)]);
  for (const w of runWarnings(method, own, callees, { async: true })) context.warn(w);
}

/** Confirmation detail rows for a method with async steps. */
function asyncDetails(method: HydratedMethod): Array<[string, string]> {
  const steps = asyncSteps(method);
  return steps.length ? [["Async steps", `${steps.join(", ")} (started, not awaited: they really run)`]] : [];
}

/** Confirmation detail rows for db steps that write (nothing is restored between runs). */
function writeDetails(method: HydratedMethod): Array<[string, string]> {
  const steps = writingSteps(method);
  return steps.length ? [["Writes data", `step ${steps.join(", ")} (not restored between runs)`]] : [];
}

/** B5: a method that writes, run more than once, leaves every run's writes; later runs see them. */
function warnWrites(method: HydratedMethod, context: CommandContext, mode: "cases" | "compare" | "both"): void {
  const steps = writingSteps(method);
  if (!steps.length) return;
  const head = `Step ${steps.join(", ")} write${steps.length > 1 ? "" : "s"} data, and nothing is restored between runs.`;
  if (mode !== "compare") context.warn(`${head} Every case's writes stay, so later cases see earlier cases' rows.`);
  if (mode !== "cases") {
    context.warn(
      `${head} --compare-published runs the DRAFT first, then the PUBLISHED copy, on the same database: the published run sees ` +
        "the draft run's rows (a 'duplicate' error or another result there is not a code difference), and both runs' writes stay.",
    );
  }
}

const compareOptions = (a: TestMethodArgs): CompareOptions => ({ ignore: a.ignore.map(parseIgnorePath), ignoreOrder: a.ignoreOrder });

/** The draft and published copies for --compare-published. */
async function resolvePair(given: HydratedMethod, uuid: string): Promise<{ draft: HydratedMethod; published: HydratedMethod; pair: { draftUuid: string; publishedUuid: string } }> {
  const pair = counterpart(given);
  if (!pair) {
    throw new CliError(
      `${given.name} (${uuid}) has no ${given.state === "PUBLISHED" ? "draft" : "published"} counterpart to compare with (state ${given.state}, no referenceId).`,
      { code: "AD_NO_PUBLISHED_COUNTERPART", details: { uuid, state: given.state } },
    );
  }
  const other = await adApi.fetchMethod(given.state === "DRAFT" ? pair.publishedUuid : pair.draftUuid, "v1");
  return given.state === "DRAFT" ? { draft: given, published: other, pair } : { draft: other, published: given, pair };
}

/** `case 12/86 PASS name (1.2s)` on stderr, so a long run is visibly alive. */
function progressLine(i: number, total: number, r: CaseResult, ms: number): string {
  const verdict = r.pass ? "PASS" : r.error?.tool ? "TOOL ERROR" : r.status === "ERROR" ? "ERROR" : "FAIL";
  const cmp = r.compare ? (r.compare.identical ? ", published identical" : `, published differs (${r.compare.mismatches.join(", ")})`) : "";
  return `case ${i + 1}/${total} ${verdict} ${r.name} (${(ms / 1000).toFixed(1)}s${r.retried ? ", retried" : ""}${cmp})`;
}

async function runCaseTable(a: TestMethodArgs, given: HydratedMethod, uuid: string, context: CommandContext) {
  const { draft: method, published, pair } = a.comparePublished ? await resolvePair(given, uuid) : { draft: given, published: undefined, pair: undefined };
  const cases = resolveCaseInputs(method, await readCases(a.casesFile!), a.inputPairs);
  for (const w of testRouteInputWarnings(method, cases.map((c) => c.inputs))) context.warn(w);
  if (published) for (const w of runWarnings(method, null, await calleeDrafts(method), { async: true })) context.warn(w);
  else await warnRun(method, context);
  warnWrites(method, context, published ? "both" : "cases");
  const runs = published ? cases.length * 2 : cases.length;
  await requireConfirmation({
    yes: a.yes,
    outputMode: context.outputMode,
    action: published
      ? `execute the method ${runs} time(s): each of ${cases.length} case(s) on the draft, then on the PUBLISHED copy, with real side effects every time`
      : `execute the method ${cases.length} time(s), once per case, with real side effects every time`,
    details: [
      ["Method", `${method.name} (${method.uuid}, ${ranVersionOf(method).label})`],
      ...(pair ? ([["Published UUID", pair.publishedUuid]] as Array<[string, string]>) : []),
      ["Cases", String(cases.length)],
      ...asyncDetails(method),
      ...writeDetails(method),
    ],
  });
  const { results, summary } = await runCases(method, cases, {
    common: a.expect.map(parseExpectation),
    ...(published ? { published, compare: compareOptions(a) } : {}),
    trace: a.trace,
    onCase: (i, total, row, ms) => printErr(progressLine(i, total, row, ms)),
  });
  const data: TestCasesData = { uuid: method.uuid, ranVersion: ranVersionOf(method), ...(pair ? { publishedUuid: pair.publishedUuid } : {}), cases: results, summary };
  if (summary.failed > 0) {
    const failed = results.filter((r) => !r.pass).map((r) => r.name);
    const tool = summary.toolErrors ? `; ${summary.toolErrors} of them are tool errors (auth / network, retried once), not the method` : "";
    return failWithData("AD_TEST_CASES_FAILED", `${summary.failed} of ${summary.total} case(s) failed${tool}: ${failed.join(", ")}.`, data, { details: { failed } });
  }
  return ok(data);
}

const command: CommandModule<TestMethodArgs, TestMethodData | TestCasesData> = {
  // Executes the chain: SQL/HTTP steps really run (and commit), so an explicit --env is required.
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    // Fail on a malformed --expect / --ignore before anything runs.
    for (const e of flags.expect) parseExpectation(e);
    for (const p of flags.ignore) parseIgnorePath(p);
    if ((flags.ignore.length > 0 || flags.ignoreOrder) && !flags.comparePublished) {
      throw new CliError("--ignore and --ignore-order shape the draft/published comparison: they need --compare-published.", { code: "MISSING_FLAG" });
    }
    if (flags.trace && !flags.cases) throw new CliError("--trace adds each case's trace to --cases rows (a single run always has data.trace).", { code: "MISSING_FLAG" });
    return {
      uuid: positionals.uuid,
      inputsFile: flags.inputs,
      inputPairs: flags.input,
      caseFile: flags.case,
      casesFile: flags.cases,
      expect: flags.expect,
      comparePublished: flags.comparePublished,
      ignore: flags.ignore,
      ignoreOrder: flags.ignoreOrder,
      trace: flags.trace,
      repeat: flags.repeat,
      yes: flags.yes,
      verbose: flags.verbose,
      raw: flags.raw,
    };
  },
  async execute(a, context) {
    const uuid = resolveMethodRef(a.uuid);
    // V1 fetch: the test body is the fetched definition (test-before-save).
    const given = await adApi.fetchMethod(uuid, "v1");
    if (a.casesFile) return runCaseTable(a, given, uuid, context);

    let draft = given;
    let published: HydratedMethod | null = null;
    let pair: { draftUuid: string; publishedUuid: string } | null = null;
    if (a.comparePublished) ({ draft, published, pair } = await resolvePair(given, uuid));

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
    for (const w of testRouteInputWarnings(draft, [values])) context.warn(w);

    // with --compare-published both copies run, so only the callees' drafts are worth a warning
    if (published) {
      for (const w of runWarnings(draft, null, await calleeDrafts(draft), { async: true })) context.warn(w);
      warnWrites(draft, context, "compare");
    } else {
      await warnRun(draft, context);
    }

    if (published && pair) {
      // the published copy runs too, with the same side effects (SQL commits,
      // HTTP calls, e-mails) — through the production body. Confirm it (--yes in --llm).
      await requireConfirmation({
        yes: a.yes,
        outputMode: context.outputMode,
        action: "execute the method TWICE (the draft first, then the PUBLISHED copy), with real side effects both times",
        details: [
          ["Draft UUID", pair.draftUuid],
          ["Published UUID", pair.publishedUuid],
          ...asyncDetails(draft),
          ...writeDetails(draft),
        ],
      });
    }
    if (a.repeat > 1) {
      await requireConfirmation({
        yes: a.yes,
        outputMode: context.outputMode,
        action: `execute the method ${a.repeat} times (--repeat), with real side effects every time`,
        details: [["Method", `${draft.name} (${draft.uuid}, ${ranVersionOf(draft).label})`], ...asyncDetails(draft), ...writeDetails(draft)],
      });
    }

    const started = Date.now();
    const run = await runInlineTest(draft, values);
    const wall = [Date.now() - started];
    const server = [run.timing.totalMs];
    for (let i = 1; i < a.repeat; i++) {
      const t0 = Date.now();
      const again = await runInlineTest(draft, values);
      wall.push(Date.now() - t0);
      server.push(again.timing.totalMs);
      printErr(`run ${i + 1}/${a.repeat}: ${again.status}, server ${again.timing.totalMs != null ? `${Math.round(again.timing.totalMs)}ms` : "-"}, wall ${wall[i]}ms`);
    }
    const data: TestMethodData = {
      uuid,
      ranVersion: ranVersionOf(draft),
      verbosity: a.verbose ? "verbose" : "normal",
      success: run.success,
      status: run.status,
      statusCode: run.statusCode,
      output: run.output,
      parsedOutput: run.parsedOutput,
      outputs: run.outputs,
      failedStep: run.failedStep,
      trace: run.trace,
      serviceResults: run.serviceResults,
      timing: run.timing,
    };
    if (expectations.length > 0 || unevaluated.length > 0) data.expectations = block(evaluateExpectations(run.outputs, expectations), unevaluated);
    if (a.repeat > 1) {
      const known = server.filter((x): x is number => x != null);
      data.repeat = { runs: a.repeat, serverMs: known.length ? repeatStats(known) : null, wallMs: repeatStats(wall) };
    }

    if (published && pair) {
      const pub = await runInlineTest(published, values);
      const opts = compareOptions(a);
      data.compare = {
        draftUuid: pair.draftUuid,
        publishedUuid: pair.publishedUuid,
        order: ["draft", "published"],
        ...compareRuns(run, pub, opts),
        ...(a.ignore.length || a.ignoreOrder ? { ignored: { paths: a.ignore, order: a.ignoreOrder } } : {}),
        draft: { status: run.status, statusCode: run.statusCode, timing: run.timing },
        published: { status: pub.status, statusCode: pub.statusCode, outputs: pub.outputs, failedStep: pub.failedStep, trace: pub.trace, timing: pub.timing },
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
      const http = run.statusCode != null ? ` (HTTP ${run.statusCode})` : "";
      const where = run.failedStep ? ` at step ${run.failedStep.index}${http}: ${run.failedStep.parsedError.summary}` : http;
      const hint = run.failedStep?.hint ? ` ${run.failedStep.hint}` : "";
      return failWithData("AD_TEST_FAILED", `The method execution FAILED${where}.${hint}`, data);
    }
    // a case whose assertions were not all evaluated is not a pass
    if (data.expectations?.unevaluated?.length) {
      const u = data.expectations.unevaluated;
      return failWithData(
        "AD_TEST_NOT_CHECKED",
        `${u.length} assertion(s) could not be evaluated locally, so the case is not checked: ${u.join("; ")}. ` +
          "Write them as {output, op, expected} (a path and .size() are allowed) to have them checked.",
        data,
      );
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    const raw = envelope.data as TestMethodData | TestCasesData | null;
    if (!raw) return;
    if ("cases" in raw) {
      ui.text(`Ran: ${raw.ranVersion.label} (${raw.ranVersion.uuid})${raw.publishedUuid ? `, then the published copy ${raw.publishedUuid}` : ""}`);
      const comparing = raw.publishedUuid !== undefined;
      ui.table(
        ["Case", "Result", "Status", "Failure", ...(comparing ? ["Published"] : [])],
        raw.cases.map((c) => [
          c.name,
          c.pass ? "PASS" : c.error?.tool ? "TOOL ERROR" : "FAIL",
          c.status,
          c.pass ? "" : caseFailure(c),
          ...(comparing ? [c.compare?.identical ? "identical" : `differs: ${c.compare?.mismatches.join(", ") ?? "?"}`] : []),
        ]),
      );
      const s = raw.summary;
      if (comparing) ui.text(`Draft vs published: ${s.identical ?? 0} identical, ${s.different ?? 0} different.`);
      // a failure's summary is the error message the runner prints
      if (s.failed === 0) ui.success(`${s.passed}/${s.total} case(s) passed.`);
      return;
    }
    const data = raw;

    ui.text(`Ran: ${data.ranVersion.label} (${data.ranVersion.uuid})`);
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

    const t = data.timing;
    ui.section(`Execution Trace${t.totalMs != null ? ` (server total ${Number(t.totalMs.toFixed(1))}ms)` : ""}`);
    ui.table(
      ["Step", "Automation ID", "Description", "Status", "Total Time", "Error"],
      data.trace.map((step) => [step.step, step.automationId, step.description, step.status, step.totalTime, step.errorSummary ?? ""]),
    );

    if (data.verbosity === "verbose") {
      for (const svc of data.serviceResults) {
        ui.section(`Step ${svc.step}: ${svc.description} [${svc.status}]`);
        if (svc.sql !== undefined) ui.text(`SQL run: ${svc.sql}`);
        if (svc.status === "skipped") ui.text("(skipped — condition not met)");
        else if (svc.status === "dispatched (async)") ui.text("(started async: it runs on, its outputs are not awaited)");
        else if (svc.outputs.length === 0) ui.text("(no outputs)");
        else ui.table(["Output", "Value"], svc.outputs.map((o) => [o.code, JSON.stringify(o.value)]));
      }
    }

    if (data.compare) {
      const c = data.compare;
      ui.section(`Draft vs published (${c.publishedUuid}; the draft ran first)`);
      const ms = (t: RunTiming) => (t.totalMs != null ? `${Math.round(t.totalMs)}ms` : "-");
      ui.text(`Server time: draft ${ms(c.draft.timing)}, published ${ms(c.published.timing)}`);
      if (!c.outputsCompared) ui.text("Both runs failed at the same step with the same error: their partial outputs were not compared.");
      if (c.identical) ui.success(`Identical: status ${c.draft.status}${c.outputsCompared ? `, ${Object.keys(data.outputs).length} output(s) equal` : ""}.`);
      else {
        if (c.draft.status !== c.published.status) ui.warn(`Status differs: draft ${c.draft.status}, published ${c.published.status}.`);
        if (c.mismatches.includes("statusCode")) ui.warn(`HTTP status differs: draft ${c.draft.statusCode ?? "-"}, published ${c.published.statusCode ?? "-"}.`);
        if (c.mismatches.includes("failedStep")) {
          const f = (x: FailedStep | null) => (x ? `step ${x.index}: ${x.parsedError.summary}` : "none");
          ui.warn(`Failing step differs: draft ${f(data.failedStep)}, published ${f(c.published.failedStep)}.`);
        }
        if (c.differences.length > 0) {
          ui.table(["Output", "Draft", "Published"], c.differences.map((d) => [d.output, JSON.stringify(d.draft), JSON.stringify(d.published)]));
        }
      }
    }

    if (data.repeat) {
      const r = data.repeat;
      const line = (x: RepeatStats | null) => (x ? `min ${Math.round(x.min)}ms, median ${Math.round(x.median)}ms, max ${Math.round(x.max)}ms` : "-");
      ui.section(`Repeat (${r.runs} runs)`);
      ui.text(`Server time: ${line(r.serverMs)}`);
      ui.text(`Wall time:   ${line(r.wallMs)}`);
    }

    if (data.expectations) {
      const x = data.expectations;
      ui.section("Expectations");
      for (const r of x.results) {
        if (r.pass) ui.success(`PASS  ${r.expectation}`);
        else ui.error(`FAIL  ${r.expectation}  — ${r.reason}`);
      }
      for (const u of x.unevaluated ?? []) ui.warn(`NOT CHECKED  ${u} (wi-impl cannot evaluate it locally)`);
      ui.text(`${x.passed}/${x.total} passed`);
    }

    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
