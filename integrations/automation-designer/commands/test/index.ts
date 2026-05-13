import { CliError, ok, type CommandModule } from "@belzabar/core";
import { InputCollector } from "../../lib/input-collector";
import { adApi } from "../../lib/api/index";
import { testMethodMultipart } from "../../lib/api/v1";
import { ErrorParser, detectJavaException, type ParsedError } from "../../lib/error-parser";
import { ServiceHydrator } from "../../lib/hydrator";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";

interface TestMethodArgs {
  uuid: string;
  inputsFile?: string;
  verbose: boolean;
  force: boolean;
  raw: boolean;
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

type InnerService = Record<string, unknown>;

const command: CommandModule<TestMethodArgs, TestMethodData> = {
  schema: "ad.test",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "test", "test");
    emitFallbackWarning(common, "test");

    const uuid = rest[0];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }
    const inputsIdx = rest.indexOf("--inputs");
    return {
      uuid,
      inputsFile: inputsIdx !== -1 ? rest[inputsIdx + 1] : undefined,
      verbose: rest.includes("--verbose"),
      force: rest.includes("--force"),
      raw: rest.includes("--raw"),
    };
  },
  async execute({ uuid, inputsFile, verbose, raw }) {
    // Fetch V1 so we can mutate `jsonDefinition` in the test payload (test-
    // before-save). The V1 raw response is what testMethodMultipart expects.
    const hydrated = await adApi.fetchMethod(uuid, "v1");
    const rawMethod = hydrated.raw as V1RawMethodResponse;

    const values = await InputCollector.collect(hydrated.inputs, inputsFile);

    // Parse inner definition
    let innerDef: Record<string, unknown> = {};
    try {
      innerDef = JSON.parse(rawMethod.jsonDefinition);
    } catch {
      throw new CliError("Failed to parse method jsonDefinition.", { code: "INVALID_DEFINITION" });
    }

    // Inject testValues
    if (Array.isArray(innerDef.inputs)) {
      innerDef.inputs = (innerDef.inputs as Array<Record<string, unknown>>).map(inp => {
        const fieldCode = typeof inp.fieldCode === "string" ? inp.fieldCode : null;
        if (fieldCode && Object.prototype.hasOwnProperty.call(values, fieldCode)) {
          return { ...inp, testValue: values[fieldCode] };
        }
        return inp;
      });
    }

    // Inject automationApiId into each service (required by Java compiler).
    if (Array.isArray(innerDef.services)) {
      innerDef.services = await Promise.all(
        (innerDef.services as InnerService[]).map(async svc => {
          if (svc.automationApiId != null) return svc;
          const aid = typeof svc.automationId === "string" ? svc.automationId : null;
          if (!aid) return svc;
          const def = await ServiceHydrator.getDefinition(aid).catch(() => null);
          if (def?.automationAPI?.id != null) {
            return { ...svc, automationApiId: def.automationAPI.id };
          }
          return svc;
        }),
      );
    }

    const payload = {
      category: rawMethod.category,
      jsonDefinition: JSON.stringify(innerDef),
      id: rawMethod.id,
      uuid: rawMethod.uuid,
      version: rawMethod.version,
    };

    const formData = new FormData();
    formData.append("body", JSON.stringify(payload));

    const resultRes = await testMethodMultipart(formData);
    if (!resultRes.ok) {
      throw new CliError(`Execution failed: ${resultRes.status} ${resultRes.statusText}`, {
        code: "TEST_EXECUTION_FAILED",
        details: await resultRes.text(),
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
    const failedSvcIndex = services.findIndex(s => s.executionStatus?.failed);
    const failedSvc = failedSvcIndex >= 0 ? services[failedSvcIndex] : null;

    const failedStep = failedSvc
      ? {
          index: failedSvcIndex + 1,
          automationId: failedSvc.automationId,
          description: failedSvc.description || "Service",
          parsedError: ErrorParser.parse(failedSvc.executionStatus),
        }
      : null;

    const trace: ServiceTraceRow[] = services.map((svc: any, idx: number) => {
      let status: ServiceTraceRow["status"] = "success";
      if (svc.executionStatus?.failed) status = "failed";
      else if (!svc.executionStatus || svc.executionStatus.executed === false) status = "skipped";
      return {
        step: idx + 1,
        automationId: svc.automationId,
        description: svc.description || "Service",
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
      return {
        step: idx + 1,
        automationId: svc.automationId,
        description: svc.description || "Service",
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
