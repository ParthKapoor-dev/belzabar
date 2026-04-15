import { readFile } from "fs/promises";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";

type Action =
  | "list"
  | "create"
  | "update"
  | "delete"
  | "bulk"
  | "run-suite"
  | "delete-suite";

interface TestCaseArgs {
  action: Action;
  chainUuid?: string;
  testCaseId?: string;
  testSuiteId?: string;
  filePath?: string;
  yes: boolean;
}

interface TestCaseData {
  action: Action;
  response: unknown;
}

const command: CommandModule<TestCaseArgs, TestCaseData> = {
  schema: "ad.test-case",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "testCase", "test-case");
    emitFallbackWarning(common, "test-case");
    const action = rest[0] as Action;
    if (!action) {
      throw new CliError("Usage: belz ad test-case <list|create|update|delete|bulk|run-suite|delete-suite> ...", {
        code: "MISSING_ACTION",
      });
    }

    const fileIdx = rest.indexOf("--file");
    const filePath = fileIdx !== -1 ? rest[fileIdx + 1] : undefined;
    const yes = rest.includes("--yes");

    switch (action) {
      case "list":
      case "create":
      case "bulk":
      case "run-suite":
        return { action, chainUuid: rest[1], filePath, yes };
      case "update":
        return { action, chainUuid: rest[1], testCaseId: rest[2], filePath, yes };
      case "delete":
        return { action, testCaseId: rest[1], yes };
      case "delete-suite":
        return { action, testSuiteId: rest[1], yes };
      default:
        throw new CliError(`Unknown action: ${action}`, { code: "INVALID_ACTION" });
    }
  },
  async execute(args, context) {
    switch (args.action) {
      case "list": {
        if (!args.chainUuid) throw new CliError("Missing <uuid>.", { code: "MISSING_UUID" });
        const response = await adApi.listTestCases(args.chainUuid);
        return ok<TestCaseData>({ action: "list", response });
      }

      case "create": {
        if (!args.chainUuid) throw new CliError("Missing <uuid>.", { code: "MISSING_UUID" });
        if (!args.filePath) throw new CliError("Missing --file argument.", { code: "MISSING_FILE" });
        const body = JSON.parse(await readFile(args.filePath, "utf-8"));
        await requireConfirmation({
          yes: args.yes,
          outputMode: context.outputMode,
          action: `create test case on method ${args.chainUuid}`,
          details: [
            ["Method UUID", args.chainUuid],
            ["Test case file", args.filePath],
            ["Test case name", typeof body?.name === "string" ? body.name : "(unknown)"],
          ],
        });
        logIntent("POST", `/rest/api/automation/chain/testcases/${args.chainUuid}`, { file: args.filePath });
        const response = await adApi.createTestCase(args.chainUuid, body);
        return ok<TestCaseData>({ action: "create", response });
      }

      case "update": {
        if (!args.chainUuid) throw new CliError("Missing <uuid>.", { code: "MISSING_UUID" });
        if (!args.testCaseId) throw new CliError("Missing <testCaseId>.", { code: "MISSING_TC_ID" });
        if (!args.filePath) throw new CliError("Missing --file argument.", { code: "MISSING_FILE" });
        const body = JSON.parse(await readFile(args.filePath, "utf-8"));
        await requireConfirmation({
          yes: args.yes,
          outputMode: context.outputMode,
          action: `update test case ${args.testCaseId}`,
          details: [
            ["Method UUID", args.chainUuid],
            ["Test case ID", args.testCaseId],
            ["File", args.filePath],
          ],
        });
        logIntent("PUT", `/rest/api/automation/chain/testcases/${args.chainUuid}/${args.testCaseId}`, {});
        const response = await adApi.updateTestCase(args.chainUuid, args.testCaseId, body);
        return ok<TestCaseData>({ action: "update", response });
      }

      case "delete": {
        if (!args.testCaseId) throw new CliError("Missing <testCaseId>.", { code: "MISSING_TC_ID" });
        await requireConfirmation({
          yes: args.yes,
          outputMode: context.outputMode,
          action: `delete test case ${args.testCaseId}`,
          details: [["Test case ID", args.testCaseId]],
        });
        logIntent("DELETE", `/rest/api/automation/chain/testcases/${args.testCaseId}`, {});
        await adApi.deleteTestCase(args.testCaseId);
        return ok<TestCaseData>({ action: "delete", response: { deleted: args.testCaseId } });
      }

      case "bulk": {
        if (!args.chainUuid) throw new CliError("Missing <uuid>.", { code: "MISSING_UUID" });
        if (!args.filePath) throw new CliError("Missing --file argument.", { code: "MISSING_FILE" });
        const body = JSON.parse(await readFile(args.filePath, "utf-8"));
        const cases = Array.isArray(body) ? body : [];
        await requireConfirmation({
          yes: args.yes,
          outputMode: context.outputMode,
          action: `bulk-create ${cases.length} test cases`,
          details: [
            ["Method UUID", args.chainUuid],
            ["File", args.filePath],
            ["Count", String(cases.length)],
          ],
        });
        logIntent("POST", `/rest/api/automation/chain/testcases/bulk/${args.chainUuid}`, { count: cases.length });
        const response = await adApi.bulkCreateTestCases(args.chainUuid, cases);
        return ok<TestCaseData>({ action: "bulk", response });
      }

      case "run-suite": {
        if (!args.chainUuid) throw new CliError("Missing <uuid>.", { code: "MISSING_UUID" });
        await requireConfirmation({
          yes: args.yes,
          outputMode: context.outputMode,
          action: `run test suite for ${args.chainUuid}`,
          details: [["Method UUID", args.chainUuid]],
        });
        logIntent("POST", "/rest/api/automation/chain/testsuite/execute", { chainUuid: args.chainUuid });
        const response = await adApi.runTestSuite(args.chainUuid);
        return ok<TestCaseData>({ action: "run-suite", response });
      }

      case "delete-suite": {
        if (!args.testSuiteId) throw new CliError("Missing <testSuiteId>.", { code: "MISSING_SUITE_ID" });
        await requireConfirmation({
          yes: args.yes,
          outputMode: context.outputMode,
          action: `delete test suite ${args.testSuiteId}`,
          details: [["Suite ID", args.testSuiteId]],
        });
        logIntent("DELETE", `/rest/api/automation/chain/testsuite/${args.testSuiteId}`, {});
        await adApi.deleteTestSuite(args.testSuiteId);
        return ok<TestCaseData>({ action: "delete-suite", response: { deleted: args.testSuiteId } });
      }
    }
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as TestCaseData;
    ui.success(`test-case ${data.action} complete`);
    if (data.action === "run-suite") {
      ui.warn(
        "Note: /testsuite/execute does NOT evaluate assertions. executionStatus=PASS " +
          "means the method ran without errors, not that assertions passed. " +
          "Use `belz ad test-report` for full evaluation results.",
      );
    }
    ui.section("Response");
    ui.object(data.response);
  },
};

export default command;
