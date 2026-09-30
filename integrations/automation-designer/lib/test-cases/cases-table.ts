// `ad test --cases <file>`: one method run against a table of input cases, each with its own
// expectations. Every case is one real /chain/test execution (runInlineTest).
import { readFile } from "fs/promises";
import { CliError } from "@belzabar/core";
import { resolveInputValues } from "../input-collector";
import { runInlineTest, type FailedStep, type TestRun } from "../test-run";
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
  outputs: Record<string, unknown>;
  failedStep: FailedStep | null;
  expectations: ExpectationResult[];
  /** The run itself threw (compile error, HTTP failure): no outputs. */
  error?: { code: string; message: string };
}

export interface CasesSummary {
  total: number;
  passed: number;
  failed: number;
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

/** Run the cases in order; `common` expectations apply to every case after its own. */
export async function runCases(method: HydratedMethod, cases: CaseRow[], common: Expectation[]): Promise<{ results: CaseResult[]; summary: CasesSummary }> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const list = [...c.expect, ...common];
    try {
      const run = await runInlineTest(method, c.inputs);
      const expectations = evaluateExpectations(run.outputs, list);
      results.push({
        name: c.name,
        pass: run.success && expectations.every((r) => r.pass),
        status: run.status,
        outputs: run.outputs,
        failedStep: run.failedStep,
        expectations,
      });
    } catch (err) {
      const code = err instanceof CliError ? err.code : "UNHANDLED_EXCEPTION";
      results.push({ name: c.name, pass: false, status: "ERROR", outputs: {}, failedStep: null, expectations: [], error: { code, message: (err as Error).message } });
    }
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, summary: { total: results.length, passed, failed: results.length - passed } };
}

/** One-cell reason a case failed (human table). */
export function caseFailure(r: CaseResult): string {
  if (r.error) return `${r.error.code}: ${r.error.message}`;
  if (r.failedStep) return `step ${r.failedStep.index}: ${r.failedStep.parsedError.summary}`;
  const bad = r.expectations.filter((e) => !e.pass);
  return bad.map((e) => `${e.expectation} (${e.reason})`).join("; ");
}
