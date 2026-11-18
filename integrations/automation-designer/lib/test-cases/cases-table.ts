// `ad test --cases <file>`: one method run against a table of input cases, each with its own
// expectations. Every case is one real /chain/test execution (runInlineTest); with
// --compare-published a second one on the published copy, right after it. A case whose run
// fails with an auth / network / gateway error (a parallel session refreshing the login) is
// retried once and, if it fails again, counted as a tool error, not a method failure.
import { readFile } from "fs/promises";
import { CliError } from "@belzabar/core";
import { resolveInputValues } from "../input-collector";
import { compareRuns, type CompareOptions, type RunComparison } from "../compare-run";
import { runInlineTest, type FailedStep, type RunTiming, type ServiceTraceRow, type TestRun } from "../test-run";
import type { HydratedMethod } from "../types/common";
import { evaluateExpectations, parseExpectation, type Expectation, type ExpectationResult } from "./expect";

interface CaseRow {
  name: string;
  inputs: Record<string, unknown>;
  expect: Expectation[];
}

export interface CaseResult {
  name: string;
  /** Executed SUCCESS and every expectation passed. */
  pass: boolean;
  status: TestRun["status"] | "ERROR";
  /** HTTP status of the run (403 for a refusal); null when the run threw or the server gave none. */
  statusCode: number | null;
  outputs: Record<string, unknown>;
  failedStep: FailedStep | null;
  expectations: ExpectationResult[];
  /** The run itself threw (compile error, HTTP failure): no outputs. `tool`: an auth / network / gateway error, not the method. */
  error?: { code: string; message: string; tool?: true };
  /** A tool error made the first attempt fail; this is the second. */
  retried?: true;
  /** `--trace` */
  trace?: ServiceTraceRow[];
  timing?: RunTiming;
  /** `--compare-published`: the same case on the published copy. */
  compare?: CaseCompare;
}

interface PublishedSide {
  status: TestRun["status"] | "ERROR";
  statusCode?: number | null;
  outputs?: Record<string, unknown>;
  failedStep?: FailedStep | null;
  trace?: ServiceTraceRow[];
  timing?: RunTiming;
  error?: { code: string; message: string; tool?: true };
}

interface CaseCompare extends RunComparison {
  published: PublishedSide;
}

export interface CasesSummary {
  total: number;
  passed: number;
  /** Every case that did not pass (toolErrors included). */
  failed: number;
  /** Cases that ended in an auth / network / gateway error after a retry: the tool, not the method. */
  toolErrors: number;
  /** `--compare-published`: cases whose draft and published runs are identical / differ. */
  identical?: number;
  different?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function invalid(path: string, message: string, extra: Obj = {}): CliError {
  return new CliError(`Cases file ${path}: ${message}`, { code: "INVALID_CASES", details: { path, ...extra } });
}

/**
 * Parse a cases file: a JSON array, or JSONL (one object per line), of
 * `{name?, inputs?: {code: value}, expect?: ["out=v", …]}`. `expect` uses the `--expect` syntax.
 */
function parseCases(text: string, path: string): CaseRow[] {
  const trimmed = text.trim();
  let entries: unknown[];
  if (trimmed.startsWith("[")) {
    try {
      entries = JSON.parse(trimmed) as unknown[];
    } catch (err) {
      throw new CliError(`Cases file ${path} is not valid JSON: ${(err as Error).message}`, { code: "INVALID_JSON", details: { path } });
    }
  } else {
    entries = [];
    trimmed.split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      try {
        entries.push(JSON.parse(line));
      } catch (err) {
        throw new CliError(`Cases file ${path} line ${i + 1} is not valid JSON: ${(err as Error).message}`, { code: "INVALID_JSON", details: { path, line: i + 1 } });
      }
    });
  }
  if (entries.length === 0) throw invalid(path, "holds no cases.");
  return entries.map((e, i) => {
    if (!isObj(e)) throw invalid(path, `case ${i + 1} must be an object {name?, inputs?, expect?}.`, { case: i + 1 });
    const inputs = e.inputs ?? {};
    if (!isObj(inputs)) throw invalid(path, `case ${i + 1}: inputs must be an object {code: value}.`, { case: i + 1 });
    const expect = e.expect ?? [];
    if (!Array.isArray(expect) || !expect.every((x) => typeof x === "string")) {
      throw invalid(path, `case ${i + 1}: expect must be an array of --expect strings ("out=value").`, { case: i + 1 });
    }
    return { name: typeof e.name === "string" && e.name ? e.name : `case ${i + 1}`, inputs, expect: expect.map(parseExpectation) };
  });
}

export async function readCases(path: string): Promise<CaseRow[]> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new CliError(`Cannot read cases file ${path}: ${(err as Error).message}`, { code: "FILE_NOT_FOUND", details: { path } });
  }
  return parseCases(text, path);
}

/**
 * Resolve every case's inputs against the method (with `pairs` on top) before anything runs, so
 * a bad row fails the command without executing the good ones.
 */
export function resolveCaseInputs(method: HydratedMethod, cases: CaseRow[], pairs: readonly string[]): CaseRow[] {
  return cases.map((c) => ({ ...c, inputs: resolveInputValues(method.inputs, c.inputs, pairs, `Case '${c.name}'`) }));
}

/** Errors of the tool, not the method: a login refreshed by a parallel session, the network, a gateway. */
const TOOL_ERROR_CODES = new Set(["AUTH_EXPIRED", "AUTH_FAILED", "AUTH_NO_TOKEN", "HTTP_NETWORK_ERROR", "HTTP_TIMEOUT"]);

function isToolError(err: unknown): boolean {
  if (!(err instanceof CliError)) return false;
  if (TOOL_ERROR_CODES.has(err.code)) return true;
  const status = (err.details as { status?: unknown } | undefined)?.status;
  return err.code === "TEST_EXECUTION_FAILED" && (status === 502 || status === 503 || status === 504);
}

type Attempt = { run: TestRun; retried: boolean } | { error: { code: string; message: string; tool?: true }; retried: boolean };

/** One run; a tool error (auth, network, gateway) is retried once. */
async function attempt(method: HydratedMethod, inputs: Record<string, unknown>): Promise<Attempt> {
  for (let i = 0; ; i++) {
    try {
      return { run: await runInlineTest(method, inputs), retried: i > 0 };
    } catch (err) {
      const tool = isToolError(err);
      if (tool && i === 0) continue;
      const code = err instanceof CliError ? err.code : "UNHANDLED_EXCEPTION";
      return { error: { code, message: (err as Error).message, ...(tool ? { tool: true as const } : {}) }, retried: i > 0 };
    }
  }
}

interface CaseRunOptions {
  /** Expectations applied to every case after its own. */
  common: Expectation[];
  /** `--compare-published`: each case also runs on this copy, after the draft. */
  published?: HydratedMethod;
  compare?: CompareOptions;
  /** `--trace`: each row carries its trace and timing. */
  trace?: boolean;
  /** Called after each case (progress). */
  onCase?: (index: number, total: number, row: CaseResult, ms: number) => void;
}

/** Run the cases in order (each on the draft, then on the published copy when comparing). */
export async function runCases(method: HydratedMethod, cases: CaseRow[], opts: CaseRunOptions): Promise<{ results: CaseResult[]; summary: CasesSummary }> {
  const results: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    const started = Date.now();
    const list = [...c.expect, ...opts.common];
    const got = await attempt(method, c.inputs);
    let row: CaseResult;
    if ("run" in got) {
      const run = got.run;
      const expectations = evaluateExpectations(run.outputs, list);
      row = {
        name: c.name,
        pass: run.success && expectations.every((r) => r.pass),
        status: run.status,
        statusCode: run.statusCode,
        outputs: run.outputs,
        failedStep: run.failedStep,
        expectations,
      };
      if (opts.trace) {
        row.trace = run.trace;
        row.timing = run.timing;
      }
    } else {
      row = { name: c.name, pass: false, status: "ERROR", statusCode: null, outputs: {}, failedStep: null, expectations: [], error: got.error };
    }
    if (got.retried) row.retried = true;
    if (opts.published) row.compare = await compareCase(got, opts.published, c.inputs, opts);
    results.push(row);
    opts.onCase?.(i, cases.length, row, Date.now() - started);
  }
  const passed = results.filter((r) => r.pass).length;
  const summary: CasesSummary = {
    total: results.length,
    passed,
    failed: results.length - passed,
    toolErrors: results.filter((r) => r.error?.tool).length,
  };
  if (opts.published) {
    summary.identical = results.filter((r) => r.compare?.identical).length;
    summary.different = results.length - summary.identical;
  }
  return { results, summary };
}

async function compareCase(draft: Attempt, published: HydratedMethod, inputs: Record<string, unknown>, opts: CaseRunOptions): Promise<CaseCompare> {
  const pub = await attempt(published, inputs);
  if (!("run" in pub)) {
    return { identical: false, mismatches: ["status"], differences: [], outputsCompared: false, published: { status: "ERROR", error: pub.error } };
  }
  const side: PublishedSide = { status: pub.run.status, statusCode: pub.run.statusCode, outputs: pub.run.outputs, failedStep: pub.run.failedStep };
  if (opts.trace) {
    side.trace = pub.run.trace;
    side.timing = pub.run.timing;
  }
  if (!("run" in draft)) return { identical: false, mismatches: ["status"], differences: [], outputsCompared: false, published: side };
  return { ...compareRuns(draft.run, pub.run, opts.compare ?? { ignore: [], ignoreOrder: false }), published: side };
}

/** One-cell reason a case failed (human table). */
export function caseFailure(r: CaseResult): string {
  if (r.error) return `${r.error.code}: ${r.error.message}`;
  if (r.failedStep) return `step ${r.failedStep.index}: ${r.failedStep.parsedError.summary}`;
  const bad = r.expectations.filter((e) => !e.pass);
  return bad.map((e) => `${e.expectation} (${e.reason})`).join("; ");
}
