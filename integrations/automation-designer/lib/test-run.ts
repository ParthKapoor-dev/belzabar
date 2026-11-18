// One inline test run (`POST /chain/test`) of a fetched V1 method, reduced to
// what `ad test` reports: status, per-step trace, and the method outputs as a
// {code: value} map (what `--expect` and `--compare-published` compare).
//
// The body is the method as fetched (test-before-save), so the same function
// runs a DRAFT and its PUBLISHED copy with identical inputs.

import { CliError, readJsonOrNull } from "@belzabar/core";
import { testMethodMultipart } from "./api/v1";
import { ErrorParser, detectJavaException, type ParsedError } from "./error-parser";
import { ServiceHydrator } from "./hydrator";
import { executionError } from "./exec-error";
import { buildV1TestPayload, stepAutomationId, v1TestFormData } from "./payload-builder";
import type { HydratedMethod, ParsedStep } from "./types/common";
import type { V1RawMethodResponse } from "./types/v1-wire";

/**
 * A step's status in a test run. An async step is never awaited: the server may report it
 * "not executed" although it was started, so it is `dispatched (async)` unless it failed.
 */
type StepStatus = "success" | "failed" | "skipped" | "dispatched (async)";

export interface ServiceTraceRow {
  /** The step's orderIndex (as `ad show` numbers it). */
  step: number;
  automationId: string;
  description: string;
  status: StepStatus;
  /** Display form of timeMs (`26ms`), or `-` when the server gave no time (a skipped step). */
  totalTime: string;
  /** Step time in milliseconds, as a number; null when the server gave none. */
  timeMs: number | null;
  /** The step loops: its time covers every iteration (the trace has no iteration count). */
  loop?: true;
  /** The step runs async: it is started, not awaited. */
  async?: true;
  errorSummary?: string;
}

export interface ServiceResult {
  step: number;
  automationId: string | number;
  description: string;
  status: StepStatus;
  outputs: Array<{ code: string; value: unknown }>;
  /** db_service steps: the SQL the server ran, with every #{…} filled in. */
  sql?: string;
  /** Each step input the server rendered: the template and the value it became. */
  renderedInputs?: Array<{ template: string | null; rendered: unknown }>;
}

/** Server-side times of the run, in milliseconds (`executionStatus.executionTime` / `totalExecutionTime`). */
export interface RunTiming {
  executionMs: number | null;
  totalMs: number | null;
}

export interface FailedStep {
  index: number;
  automationId: string;
  description: string;
  parsedError: ParsedError;
  /** HTTP status the step failed with (its exit code: 403, 422, …), when the server gives one. */
  statusCode?: number;
}

export interface TestRun {
  success: boolean;
  status: "SUCCESS" | "FAILED";
  /** HTTP status of the run (`executionStatus.statusCode`): what `ad run` would answer, e.g. 403 for a refusal. */
  statusCode: number | null;
  /** First method output's raw test result (kept for compatibility). */
  output: unknown;
  parsedOutput: unknown;
  /** Every method output: code → value (JSON text parsed). */
  outputs: Record<string, unknown>;
  failedStep: FailedStep | null;
  trace: ServiceTraceRow[];
  serviceResults: ServiceResult[];
  timing: RunTiming;
  executionResult: Record<string, unknown>;
}

function parseOutput(testResult: unknown): unknown {
  if (typeof testResult !== "string") return testResult;
  const trimmed = testResult.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(testResult);
    } catch {
      return testResult;
    }
  }
  return testResult;
}

/**
 * The method step a test-response row belongs to: by position (the response
 * lists steps in order), confirmed by automationId when both carry one, else
 * the first step with that automationId. Falls back to the row itself.
 */
export function matchStep(steps: ParsedStep[], svc: Record<string, unknown>, idx: number): { step: number; description: string } {
  const { step, description } = matchParsedStep(steps, svc, idx);
  return { step, description };
}

function matchParsedStep(steps: ParsedStep[], svc: Record<string, unknown>, idx: number): { step: number; description: string; hit?: ParsedStep } {
  const ordered = [...steps].sort((a, b) => a.orderIndex - b.orderIndex);
  const aid = stepAutomationId(svc);
  const sameId = (s: ParsedStep | undefined) => !!s && (!aid || !s.automationId || String(s.automationId).trim() === aid);
  let hit: ParsedStep | undefined = ordered[idx];
  if (!sameId(hit)) hit = aid ? ordered.find((s) => String(s.automationId ?? "").trim() === aid) : undefined;
  const own = typeof svc.description === "string" && svc.description ? svc.description : undefined;
  return {
    step: hit?.orderIndex ?? idx + 1,
    description: hit?.description || own || "Service",
    hit,
  };
}

/** Method outputs of a test response: `outputs[].code` → parsed `testResult`. */
export function outputsMap(result: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const o of Array.isArray(result.outputs) ? result.outputs : []) {
    if (!o || typeof o !== "object") continue;
    const row = o as Record<string, unknown>;
    const code = typeof row.code === "string" ? row.code : typeof row.outputCode === "string" ? row.outputCode : null;
    // the test route sends no testResult for an empty or null output: keep the key, as null
    if (code) map[code] = row.testResult === undefined ? null : parseOutput(row.testResult);
  }
  return map;
}

type Svc = Record<string, any>;

function stepStatus(svc: Svc, step?: ParsedStep): StepStatus {
  if (svc.executionStatus?.failed) return "failed";
  if (step?.runAsync) return "dispatched (async)";
  if (!svc.executionStatus || svc.executionStatus.executed === false) return "skipped";
  return "success";
}

const UNIT_MS: Record<string, number> = { milliseconds: 1, ms: 1, seconds: 1000, s: 1000, microseconds: 1e-3, nanoseconds: 1e-6 };

/** An `{time, unit}` as milliseconds; null when absent or not a number. */
function toMs(et: unknown): number | null {
  if (!et || typeof et !== "object") return null;
  const { time, unit } = et as { time?: unknown; unit?: unknown };
  if (typeof time !== "number" || !Number.isFinite(time)) return null;
  return time * (UNIT_MS[typeof unit === "string" ? unit : "milliseconds"] ?? 1);
}

/**
 * A step's time in ms. A loop step's time comes in nanoseconds labelled "milliseconds"
 * (live: 4416738 "ms" for a 3-iteration echo loop in a 400 ms run), so a loop step whose time
 * is longer than the whole run is read as nanoseconds.
 */
function stepMs(svc: Svc, step: ParsedStep | undefined, runMs: number | null): number | null {
  const ms = toMs(svc.executionStatus?.executionTime);
  if (ms == null) return null;
  if (step?.repeatStepExecution && runMs != null && ms > runMs) return ms / 1e6;
  return ms;
}

function msText(ms: number | null): string {
  return ms == null ? "-" : `${Number(ms.toFixed(3))}ms`;
}

type Rendered = { template: string | null; rendered: unknown };

/** Every leaf of a step's input mappings the server rendered (`testResult`). */
function renderedInputs(svc: Svc): Rendered[] {
  const out: Rendered[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const m of list as Svc[]) {
      if (!m || typeof m !== "object") continue;
      if (m.testResult !== undefined) out.push({ template: typeof m.value === "string" ? m.value : null, rendered: m.testResult });
      walk(m.mappings);
    }
  };
  walk(svc.mappings);
  return out;
}

/** The rendered SQL of a db_service step: the input whose template is the step's SQL (or its only rendered text). */
function renderedSql(step: ParsedStep | undefined, inputs: Rendered[]): string | undefined {
  if (step?.kind !== "SQL") return undefined;
  const texts = inputs.filter((i) => typeof i.rendered === "string");
  const hit = texts.find((i) => i.template?.trim() === step.sql.trim()) ?? (texts.length === 1 ? texts[0] : undefined);
  return hit ? (hit.rendered as string) : undefined;
}

const TEST_PATH = "/rest/api/automation/chain/test";

/** Run a fetched V1 method inline with `values` as its inputs' test values. */
export async function runInlineTest(hydrated: HydratedMethod, values: Record<string, unknown>): Promise<TestRun> {
  const rawMethod = hydrated.raw as V1RawMethodResponse;
  const payload = await buildV1TestPayload(rawMethod, values);
  const resultRes = await testMethodMultipart(v1TestFormData(payload));
  if (!resultRes.ok) {
    throw await executionError(resultRes, { code: "TEST_EXECUTION_FAILED", label: "Execution failed", path: TEST_PATH, tag: "ad-test" });
  }
  const result = (await readJsonOrNull<Record<string, unknown>>(resultRes, { path: TEST_PATH })) ?? {};

  // Java exception body — the backend answers 200 with a thrown exception
  // object when a chain fails to compile.
  const javaExc = detectJavaException(result);
  if (javaExc) {
    if (javaExc.badAutomationApiId) {
      const badId = javaExc.badAutomationApiId;
      const badStep = hydrated.parsedSteps.find((s) => String(s.automationId) === badId);
      const def = await ServiceHydrator.getDefinition(badId).catch(() => null);
      const systemLabel = def?.automationAPI?.automationSystem?.label;
      const isRemote = def?.automationAPI?.automationSystem?.remote;
      let hint = "";
      if (badStep) hint += ` — step [${badStep.orderIndex}]: "${badStep.description ?? badStep.automationId}"`;
      if (isRemote && systemLabel) hint += ` uses remote system "${systemLabel}" which cannot be compiled in test mode`;
      else if (systemLabel) hint += ` (${systemLabel})`;
      throw new CliError(`${javaExc.message}${hint}`, { code: "BACKEND_COMPILATION_ERROR" });
    }
    const detail = javaExc.causeMessage ? `${javaExc.message}: ${javaExc.causeMessage}` : javaExc.message;
    throw new CliError(detail, { code: "BACKEND_COMPILATION_ERROR" });
  }

  const services: Svc[] = Array.isArray(result.services) ? (result.services as Svc[]) : [];
  // the test response omits step descriptions and orderIndex — join each row to the method's own steps.
  const stepFor = (svc: Svc, idx: number) => matchParsedStep(hydrated.parsedSteps, svc, idx);
  const execStatus = result.executionStatus as Record<string, unknown> | undefined;
  const timing: RunTiming = { executionMs: toMs(execStatus?.executionTime), totalMs: toMs(execStatus?.totalExecutionTime) };
  const runMs = timing.totalMs ?? timing.executionMs;
  const failedIdx = services.findIndex((s) => s.executionStatus?.failed);
  const failedSvc = failedIdx >= 0 ? services[failedIdx]! : null;
  const failedStep: FailedStep | null = failedSvc
    ? {
        index: stepFor(failedSvc, failedIdx).step,
        automationId: failedSvc.automationId,
        description: stepFor(failedSvc, failedIdx).description,
        parsedError: ErrorParser.parse(failedSvc.executionStatus),
        ...(typeof failedSvc.executionStatus?.statusCode === "number" ? { statusCode: failedSvc.executionStatus.statusCode } : {}),
      }
    : null;

  const trace: ServiceTraceRow[] = services.map((svc, idx) => {
    const meta = stepFor(svc, idx);
    const timeMs = stepMs(svc, meta.hit, runMs);
    const row: ServiceTraceRow = {
      step: meta.step,
      automationId: svc.automationId,
      description: meta.description,
      status: stepStatus(svc, meta.hit),
      totalTime: msText(timeMs),
      timeMs,
      errorSummary: svc.executionStatus?.failed ? ErrorParser.parse(svc.executionStatus).summary : undefined,
    };
    if (meta.hit?.repeatStepExecution) row.loop = true;
    if (meta.hit?.runAsync) row.async = true;
    return row;
  });

  const serviceResults: ServiceResult[] = services.map((svc, idx) => {
    const meta = stepFor(svc, idx);
    const rendered = renderedInputs(svc);
    const sr: ServiceResult = {
      step: meta.step,
      automationId: svc.automationId,
      description: meta.description,
      status: stepStatus(svc, meta.hit),
      outputs: ((svc.outputs || []) as Svc[])
        .filter((o) => o.testResult !== undefined)
        .map((o) => ({ code: o.code, value: parseOutput(o.testResult) })),
    };
    const sql = renderedSql(meta.hit, rendered);
    if (sql !== undefined) sr.sql = sql;
    if (rendered.length > 0) sr.renderedInputs = rendered;
    return sr;
  });

  const outputsArr = Array.isArray(result.outputs) ? (result.outputs as Svc[]) : [];
  const output = outputsArr[0]?.testResult ?? null;
  const success = !execStatus?.failed;
  return {
    success,
    status: success ? "SUCCESS" : "FAILED",
    statusCode: typeof execStatus?.statusCode === "number" ? execStatus.statusCode : null,
    output,
    parsedOutput: parseOutput(output),
    outputs: outputsMap(result),
    failedStep,
    trace,
    serviceResults,
    timing,
    executionResult: result,
  };
}

// ── draft vs published ────────────────────────────────────────────

export interface OutputDifference {
  output: string;
  draft: unknown;
  published: unknown;
}

export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
        : x;
  return JSON.stringify(sort(v)) ?? "undefined";
}

/** Output-by-output differences between a draft run and a published run. */
export function diffOutputs(draft: Record<string, unknown>, published: Record<string, unknown>): OutputDifference[] {
  const keys = [...new Set([...Object.keys(draft), ...Object.keys(published)])].sort();
  const out: OutputDifference[] = [];
  for (const k of keys) {
    if (canonical(draft[k]) !== canonical(published[k])) out.push({ output: k, draft: draft[k], published: published[k] });
  }
  return out;
}

/**
 * The draft/published pair for a method uuid: a DRAFT names its published
 * copy in `referenceId`, a PUBLISHED method names its draft there.
 */
export function counterpart(method: HydratedMethod): { draftUuid: string; publishedUuid: string } | null {
  const ref = (method.referenceId ?? "").trim().toLowerCase();
  const own = method.uuid.trim().toLowerCase();
  if (!ref) return null;
  if (method.state === "DRAFT") return { draftUuid: own, publishedUuid: ref };
  if (method.state === "PUBLISHED") return { draftUuid: ref, publishedUuid: own };
  return null;
}
