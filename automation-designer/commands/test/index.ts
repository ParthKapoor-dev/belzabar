import { CliError, ok, type CommandModule } from "@belzabar/core";
import { InputCollector } from "../../lib/input-collector";
import { testMethod, fetchMethodDefinition } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";
import { ErrorParser, type ParsedError } from "../../lib/error-parser";
import { ServiceHydrator } from "../../lib/hydrator";
import type { RawMethodResponse } from "../../lib/types";

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

const command: CommandModule<TestMethodArgs, TestMethodData> = {
  schema: "ad.test",
  parseArgs(args) {
    const uuid = args[0];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }
    return {
      uuid,
      inputsFile: args.indexOf("--inputs") !== -1 ? args[args.indexOf("--inputs") + 1] : undefined,
      verbose: args.includes("--verbose"),
      force: args.includes("--force"),
      raw: args.includes("--raw"),
    };
  },
  async execute({ uuid, inputsFile, verbose, raw }) {
    const rawMethod = (await fetchMethodDefinition(uuid)) as RawMethodResponse;
    const hydrated = parseMethodResponse(rawMethod);
    const values = await InputCollector.collect(hydrated.inputs, inputsFile);

    // Parse inner definition
    let innerDef: any = {};
    try {
      innerDef = JSON.parse(rawMethod.jsonDefinition);
    } catch {
      throw new CliError("Failed to parse method jsonDefinition.", { code: "INVALID_DEFINITION" });
    }

    // Inject testValues into inputs
    if (Array.isArray(innerDef.inputs)) {
      innerDef.inputs = innerDef.inputs.map((inp: any) => {
        if (Object.prototype.hasOwnProperty.call(values, inp.fieldCode)) {
          return { ...inp, testValue: values[inp.fieldCode] };
        }
        return inp;
      });
    }

    // Inject automationApiId into each service (required by Java compiler)
    if (Array.isArray(innerDef.services)) {
      innerDef.services = await Promise.all(
        innerDef.services.map(async (svc: any) => {
          if (svc.automationApiId) return svc;
          const def = await ServiceHydrator.getDefinition(String(svc.automationId)).catch(() => null);
          if (def?.automationAPI?.id) {
            return { ...svc, automationApiId: def.automationAPI.id };
          }
          return svc;
        })
      );
    }

    // Build minimal payload matching web UI format
    const payload = {
      category: rawMethod.category,
      jsonDefinition: JSON.stringify(innerDef),
      id: rawMethod.id,
      uuid: rawMethod.uuid,
      version: rawMethod.version,
    };

    const formData = new FormData();
    formData.append("body", JSON.stringify(payload));

    const resultRes = await testMethod(formData);
    if (!resultRes.ok) {
      throw new CliError(`Execution failed: ${resultRes.status} ${resultRes.statusText}`, {
        code: "TEST_EXECUTION_FAILED",
        details: await resultRes.text(),
      });
    }

    const result = await resultRes.json();

    // Detect Java exception body — backend returns HTTP 200 with a thrown exception object
    // when the chain fails to compile (e.g. a service references a remote automation system
    // that the test runtime cannot resolve).
    if (result.message && Array.isArray(result.stackTrace) && !result.services && !result.executionStatus) {
      const causeMsg = result.cause?.message ?? result.cause?.localizedMessage;

      // Try to enrich the error: identify which service is at fault and whether it's remote.
      const idMatch = causeMsg?.match(/Invalid Automation API Id - (\d+)/);
      if (idMatch) {
        const badId = idMatch[1];
        const badSvc = hydrated.services.find(s => String(s.automationId) === badId);
        const def = await ServiceHydrator.getDefinition(badId).catch(() => null);
        const systemLabel = def?.automationAPI?.automationSystem?.label;
        const isRemote = def?.automationAPI?.automationSystem?.remote;

        let hint = "";
        if (badSvc) hint += ` — service [step ${badSvc.orderIndex}]: "${badSvc.description || badSvc.automationId}"`;
        if (isRemote && systemLabel) hint += ` uses remote system "${systemLabel}" which cannot be compiled in test mode`;
        else if (systemLabel) hint += ` (${systemLabel})`;

        throw new CliError(`${result.message}${hint}`, { code: "BACKEND_COMPILATION_ERROR" });
      }

      const detail = causeMsg ? `${result.message}: ${causeMsg}` : result.message;
      throw new CliError(detail, { code: "BACKEND_COMPILATION_ERROR" });
    }

    const failedSvcIndex = result.services?.findIndex((s: any) => s.executionStatus?.failed) ?? -1;
    const failedSvc = failedSvcIndex >= 0 ? result.services[failedSvcIndex] : null;

    const failedStep = failedSvc
      ? {
          index: failedSvcIndex + 1,
          automationId: failedSvc.automationId,
          description: failedSvc.description || "Service",
          parsedError: ErrorParser.parse(failedSvc.executionStatus),
        }
      : null;

    const trace: ServiceTraceRow[] = (result.services || []).map((svc: any, idx: number) => {
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

    const output = result.outputs?.[0]?.testResult ?? null;
    const parsedOutput = parseOutput(output);
    const success = !result.executionStatus?.failed;

    const serviceResults: ServiceResult[] = (result.services || []).map((svc: any, idx: number) => {
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
