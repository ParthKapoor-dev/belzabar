// One inline test run (`POST /chain/test`) of a fetched V1 method, reduced to
// what `ad test` reports: status, per-step trace, and the method outputs as a
// {code: value} map (what `--expect` and `--compare-published` compare).
//
// The body is the method as fetched (test-before-save), so the same function
// runs a DRAFT and its PUBLISHED copy with identical inputs (7.12).

import { CliError, readJsonOrNull } from "@belzabar/core";
import { testMethodMultipart } from "./api/v1";
import { ErrorParser, detectJavaException, type ParsedError } from "./error-parser";
import { ServiceHydrator } from "./hydrator";
import { buildV1TestPayload, describeTestFailure, stepAutomationId, v1TestFormData } from "./payload-builder";
import type { HydratedMethod, ParsedStep } from "./types/common";
import type { V1RawMethodResponse } from "./types/v1-wire";

export interface ServiceTraceRow {
  step: number;
  automationId: string;
  description: string;
  status: "success" | "failed" | "skipped";
  totalTime: string;
  errorSummary?: string;
}

export interface ServiceResult {
  step: number;
  automationId: string | number;
  description: string;
  status: "success" | "failed" | "skipped";
  outputs: Array<{ code: string; value: unknown }>;
}

export interface FailedStep {
  index: number;
  automationId: string;
  description: string;
  parsedError: ParsedError;
}

export interface TestRun {
  success: boolean;
  status: "SUCCESS" | "FAILED";
  /** First method output's raw test result (kept for compatibility). */
  output: unknown;
  parsedOutput: unknown;
  /** Every method output: code → value (JSON text parsed). */
  outputs: Record<string, unknown>;
  failedStep: FailedStep | null;
  trace: ServiceTraceRow[];
  serviceResults: ServiceResult[];
  executionResult: Record<string, unknown>;
}

export function parseOutput(testResult: unknown): unknown {
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
  const ordered = [...steps].sort((a, b) => a.orderIndex - b.orderIndex);
  const aid = stepAutomationId(svc);
  const sameId = (s: ParsedStep | undefined) => !!s && (!aid || !s.automationId || String(s.automationId).trim() === aid);
  let hit: ParsedStep | undefined = ordered[idx];
  if (!sameId(hit)) hit = aid ? ordered.find((s) => String(s.automationId ?? "").trim() === aid) : undefined;
  const own = typeof svc.description === "string" && svc.description ? svc.description : undefined;
  return {
    step: hit?.orderIndex ?? idx + 1,
    description: hit?.description || own || "Service",
  };
}

/** Method outputs of a test response: `outputs[].code` → parsed `testResult`. */
export function outputsMap(result: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const o of Array.isArray(result.outputs) ? result.outputs : []) {
    if (!o || typeof o !== "object") continue;
    const row = o as Record<string, unknown>;
    const code = typeof row.code === "string" ? row.code : typeof row.outputCode === "string" ? row.outputCode : null;
    if (code) map[code] = parseOutput(row.testResult);
  }
  return map;
}

type Svc = Record<string, any>;

function stepStatus(svc: Svc): "success" | "failed" | "skipped" {
  if (svc.executionStatus?.failed) return "failed";
  if (!svc.executionStatus || svc.executionStatus.executed === false) return "skipped";
  return "success";
}

/** Run a fetched V1 method inline with `values` as its inputs' test values. */
export async function runInlineTest(hydrated: HydratedMethod, values: Record<string, unknown>): Promise<TestRun> {
  const rawMethod = hydrated.raw as V1RawMethodResponse;
  const payload = await buildV1TestPayload(rawMethod, values);
  const resultRes = await testMethodMultipart(v1TestFormData(payload));
  if (!resultRes.ok) {
    const failure = await describeTestFailure(resultRes);
    throw new CliError(`Execution failed: ${failure.message}`, {
      code: "TEST_EXECUTION_FAILED",
      details: { status: resultRes.status, body: failure.body },
    });
  }
  const result = (await readJsonOrNull<Record<string, unknown>>(resultRes, { path: "/rest/api/automation/chain/test" })) ?? {};

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
  // AD-17: the test response omits step descriptions and orderIndex — join each row to the method's own steps.
  const stepFor = (svc: Svc, idx: number) => matchStep(hydrated.parsedSteps, svc, idx);
  const failedIdx = services.findIndex((s) => s.executionStatus?.failed);
  const failedSvc = failedIdx >= 0 ? services[failedIdx]! : null;
  const failedStep: FailedStep | null = failedSvc
    ? {
        index: stepFor(failedSvc, failedIdx).step,
        automationId: failedSvc.automationId,
        description: stepFor(failedSvc, failedIdx).description,
        parsedError: ErrorParser.parse(failedSvc.executionStatus),
      }
    : null;

  const trace: ServiceTraceRow[] = services.map((svc, idx) => {
    const meta = stepFor(svc, idx);
    const et = svc.executionStatus?.executionTime;
    return {
      step: meta.step,
      automationId: svc.automationId,
      description: meta.description,
      status: stepStatus(svc),
      totalTime: !et || et.time == null ? "-" : `${et.time}${et.unit === "milliseconds" ? "ms" : (et.unit ?? "ms")}`,
      errorSummary: svc.executionStatus?.failed ? ErrorParser.parse(svc.executionStatus).summary : undefined,
    };
  });

  const serviceResults: ServiceResult[] = services.map((svc, idx) => {
    const meta = stepFor(svc, idx);
    return {
      step: meta.step,
      automationId: svc.automationId,
      description: meta.description,
      status: stepStatus(svc),
      outputs: ((svc.outputs || []) as Svc[])
        .filter((o) => o.testResult !== undefined)
        .map((o) => ({ code: o.code, value: parseOutput(o.testResult) })),
    };
  });

  const outputsArr = Array.isArray(result.outputs) ? (result.outputs as Svc[]) : [];
  const output = outputsArr[0]?.testResult ?? null;
  const execStatus = result.executionStatus as Record<string, unknown> | undefined;
  const success = !execStatus?.failed;
  return {
    success,
    status: success ? "SUCCESS" : "FAILED",
    output,
    parsedOutput: parseOutput(output),
    outputs: outputsMap(result),
    failedStep,
    trace,
    serviceResults,
    executionResult: result,
  };
}

// ── draft vs published (7.12) ────────────────────────────────────────────

export interface OutputDifference {
  output: string;
  draft: unknown;
  published: unknown;
}

function canonical(v: unknown): string {
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
