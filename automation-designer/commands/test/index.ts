import { CliError, ok, type CommandModule } from "@belzabar/core";
import { InputCollector } from "../../lib/input-collector";
import { testMethod, fetchMethodDefinition } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";
import { PayloadBuilder } from "../../lib/payload-builder";
import { ErrorParser, type ParsedError } from "../../lib/error-parser";
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
    const payload = PayloadBuilder.injectInputs(rawMethod, values);

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
      else if (!svc.executionStatus) status = "skipped";
      return {
        step: idx + 1,
        automationId: svc.automationId,
        description: svc.description || "Service",
        status,
        totalTime: svc.executionStatus?.executionTime?.totalTime || "0ms",
        errorSummary: svc.executionStatus?.failed
          ? ErrorParser.parse(svc.executionStatus).summary
          : undefined,
      };
    });

    const output = result.outputs?.[0]?.testResult ?? null;
    const parsedOutput = parseOutput(output);
    const success = !result.executionStatus?.failed;

    const data: TestMethodData = {
      uuid,
      verbosity: verbose ? "verbose" : "normal",
      success,
      status: success ? "SUCCESS" : "FAILED",
      output,
      parsedOutput,
      failedStep,
      trace,
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

    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
