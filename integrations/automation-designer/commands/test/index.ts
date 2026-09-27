import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { InputCollector } from "../../lib/input-collector";
import { adApi } from "../../lib/api/index";
import { testMethodMultipart } from "../../lib/api/v1";
import { ErrorParser, detectJavaException, type ParsedError } from "../../lib/error-parser";
import { ServiceHydrator } from "../../lib/hydrator";
import { buildV1TestPayload, describeTestFailure, stepAutomationId, v1TestFormData } from "../../lib/payload-builder";
import { resolveMethodRef } from "../../lib/ids";
import type { ParsedStep } from "../../lib/types/common";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";

interface TestMethodArgs {
  uuid: string;
  inputsFile?: string;
  verbose: boolean;
  raw: boolean;
  force: boolean;
}

interface ServiceTraceRow {
  step: number;
  automationId: string;
  description: string;
  status: "success" | "failed" | "skipped";
  totalTime: string;
  errorSummary?: string;
}

interface ServiceOutputRow {
  code: string;
  value: unknown;
}

interface ServiceResult {
  step: number;
  automationId: string | number;
  description: string;
  status: "success" | "failed" | "skipped";
  outputs: ServiceOutputRow[];
}

interface TestMethodData {
  uuid: string;
  verbosity: "normal" | "verbose";
  success: boolean;
  status: "SUCCESS" | "FAILED";
  output: unknown;
  parsedOutput: unknown;
  failedStep: {
    index: number;
    automationId: string;
    description: string;
    parsedError: ParsedError;
  } | null;
  trace: ServiceTraceRow[];
  serviceResults: ServiceResult[];
  raw?: {
    executionResult: unknown;
  };
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

export const args = defineArgs({
  command: "belz ad test",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: {
    ...AD_COMMON_FLAGS,
    inputs: { type: "string" },
    // A command flag, not the runner's debug switch (CORE-7): declared here so
    // the runner hands `--verbose`/`-v` to this command.
    verbose: { type: "boolean", alias: ["-v"] },
    raw: { type: "boolean" },
    // Removed no-op kept so old scripts/skills (`--force`) don't hit UNKNOWN_FLAG.
    force: { type: "boolean", hidden: true },
  },
});

/**
 * The method step a test-response row belongs to: by position (the response
 * lists steps in order), confirmed by automationId when both carry one, else
 * the first step with that automationId. Falls back to the row itself.
 */
export function matchStep(
  steps: ParsedStep[],
  svc: Record<string, unknown>,
  idx: number,
): { step: number; description: string } {
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

const command: CommandModule<TestMethodArgs, TestMethodData> = {
  schema: "ad.test",
  // Executes the chain: SQL/HTTP steps really run (and commit), so an explicit --env is required.
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "test", "test");
    return {
      uuid: positionals.uuid,
      inputsFile: flags.inputs,
      verbose: flags.verbose,
      raw: flags.raw,
      force: flags.force,
    };
  },
  async execute({ uuid: uuidArg, inputsFile, verbose, raw, force }, context) {
    if (force) context.warn("--force is deprecated and does nothing (ad test never used the cache).");
    const uuid = resolveMethodRef(uuidArg);
    // Fetch V1 so we can mutate `jsonDefinition` in the test payload (test-
    // before-save). The V1 raw response is what testMethodMultipart expects.
    const hydrated = await adApi.fetchMethod(uuid, "v1");
    const rawMethod = hydrated.raw as V1RawMethodResponse;

    const values = await InputCollector.collect(hydrated.inputs, inputsFile);

    const payload = await buildV1TestPayload(rawMethod, values);
    const resultRes = await testMethodMultipart(v1TestFormData(payload));
    if (!resultRes.ok) {
      const failure = await describeTestFailure(resultRes);
      throw new CliError(`Execution failed: ${failure.message}`, {
        code: "TEST_EXECUTION_FAILED",
        details: { status: resultRes.status, body: failure.body },
      });
    }

    const result = (await resultRes.json()) as Record<string, unknown>;

    // Java exception body — backend returns HTTP 200 with a thrown exception
    // object when a chain fails to compile.
    const javaExc = detectJavaException(result);
    if (javaExc) {
      if (javaExc.badAutomationApiId) {
        const badId = javaExc.badAutomationApiId;
        const badStep = hydrated.parsedSteps.find(s => String(s.automationId) === badId);
        const def = await ServiceHydrator.getDefinition(badId).catch(() => null);
        const systemLabel = def?.automationAPI?.automationSystem?.label;
        const isRemote = def?.automationAPI?.automationSystem?.remote;

        let hint = "";
        if (badStep) {
          hint += ` — step [${badStep.orderIndex}]: "${badStep.description ?? badStep.automationId}"`;
        }
        if (isRemote && systemLabel) {
          hint += ` uses remote system "${systemLabel}" which cannot be compiled in test mode`;
        } else if (systemLabel) {
          hint += ` (${systemLabel})`;
        }
        throw new CliError(`${javaExc.message}${hint}`, { code: "BACKEND_COMPILATION_ERROR" });
      }

      const detail = javaExc.causeMessage ? `${javaExc.message}: ${javaExc.causeMessage}` : javaExc.message;
      throw new CliError(detail, { code: "BACKEND_COMPILATION_ERROR" });
    }

    const services = Array.isArray(result.services) ? (result.services as any[]) : [];
    // AD-17: the test response omits step descriptions and orderIndex — join
    // each row to the method's own steps.
    const stepFor = (svc: any, idx: number) => matchStep(hydrated.parsedSteps, svc, idx);
    const failedSvcIndex = services.findIndex(s => s.executionStatus?.failed);
    const failedSvc = failedSvcIndex >= 0 ? services[failedSvcIndex] : null;

    const failedStep = failedSvc
      ? {
          index: stepFor(failedSvc, failedSvcIndex).step,
          automationId: failedSvc.automationId,
          description: stepFor(failedSvc, failedSvcIndex).description,
          parsedError: ErrorParser.parse(failedSvc.executionStatus),
        }
      : null;

    const trace: ServiceTraceRow[] = services.map((svc: any, idx: number) => {
      let status: ServiceTraceRow["status"] = "success";
      if (svc.executionStatus?.failed) status = "failed";
      else if (!svc.executionStatus || svc.executionStatus.executed === false) status = "skipped";
      const meta = stepFor(svc, idx);
      return {
        step: meta.step,
        automationId: svc.automationId,
        description: meta.description,
        status,
        totalTime: (() => {
          const et = svc.executionStatus?.executionTime;
          if (!et || et.time == null) return "-";
          const unit = et.unit === "milliseconds" ? "ms" : (et.unit ?? "ms");
          return `${et.time}${unit}`;
        })(),
        errorSummary: svc.executionStatus?.failed
          ? ErrorParser.parse(svc.executionStatus).summary
          : undefined,
      };
    });

    const outputsArr = Array.isArray(result.outputs) ? (result.outputs as any[]) : [];
    const output = outputsArr[0]?.testResult ?? null;
    const parsedOutput = parseOutput(output);
    const execStatus = result.executionStatus as Record<string, unknown> | undefined;
    const success = !execStatus?.failed;

    const serviceResults: ServiceResult[] = services.map((svc: any, idx: number) => {
      let status: ServiceResult["status"] = "success";
      if (svc.executionStatus?.failed) status = "failed";
      else if (!svc.executionStatus || svc.executionStatus.executed === false) status = "skipped";
      const outputs: ServiceOutputRow[] = (svc.outputs || [])
        .filter((o: any) => o.testResult !== undefined)
        .map((o: any) => ({ code: o.code, value: parseOutput(o.testResult) }));
      const meta = stepFor(svc, idx);
      return {
        step: meta.step,
        automationId: svc.automationId,
        description: meta.description,
        status,
        outputs,
      };
    });

    const data: TestMethodData = {
      uuid,
      verbosity: verbose ? "verbose" : "normal",
      success,
      status: success ? "SUCCESS" : "FAILED",
      output,
      parsedOutput,
      failedStep,
      trace,
      serviceResults,
    };

    if (raw) {
      data.raw = { executionResult: result };
    }

    return ok(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as TestMethodData;

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
          ]
        );
        ui.text(data.failedStep.parsedError.detail);
      }
    }

    ui.section("Final Output");
    if (data.output === null || data.output === undefined) {
      ui.text("(No Output)");
    } else {
      ui.object(data.parsedOutput);
    }

    ui.section("Execution Trace");
    ui.table(
      ["Step", "Automation ID", "Description", "Status", "Total Time", "Error"],
      data.trace.map(step => [
        step.step,
        step.automationId,
        step.description,
        step.status,
        step.totalTime,
        step.errorSummary ?? "",
      ])
    );

    if (data.verbosity === "verbose") {
      for (const svc of data.serviceResults) {
        ui.section(`Step ${svc.step}: ${svc.description} [${svc.status}]`);
        if (svc.status === "skipped") {
          ui.text("(skipped — condition not met)");
        } else if (svc.outputs.length === 0) {
          ui.text("(no outputs)");
        } else {
          ui.table(
            ["Output", "Value"],
            svc.outputs.map(o => [o.code, JSON.stringify(o.value)])
          );
        }
      }
    }

    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
