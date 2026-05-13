import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";

interface TestCasesArgs {
  uuid: string;
}

interface TestCaseRow {
  id: string;
  name: string;
  active: boolean;
  inputCount: number;
  assertionCount: number;
}

interface TestCasesData {
  uuid: string;
  testSuiteId: string | null;
  executionStatus: string | null;
  active: boolean | null;
  total: number;
  testCases: TestCaseRow[];
}

const command: CommandModule<TestCasesArgs, TestCasesData> = {
  schema: "ad.test-cases",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "testCase", "test-cases");
    emitFallbackWarning(common, "test-cases");
    const uuid = rest[0];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }
    return { uuid };
  },
  async execute({ uuid }) {
    const body = (await adApi.listTestCases(uuid)) as any;

    const suite =
      body && typeof body === "object" && !Array.isArray(body)
        ? body
        : { testCases: Array.isArray(body) ? body : [] };

    const cases: unknown[] = Array.isArray(suite.testCases) ? suite.testCases : [];

    const testCases: TestCaseRow[] = cases
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map(c => ({
        id: typeof c.id === "string" ? c.id : "",
        name: typeof c.name === "string" ? c.name : "",
        active: c.active !== false,
        inputCount: Array.isArray(c.inputs) ? c.inputs.length : 0,
        assertionCount: Array.isArray(c.assertions) ? c.assertions.length : 0,
      }));

    return ok<TestCasesData>({
      uuid,
      testSuiteId: typeof suite.id === "string" ? suite.id : null,
      executionStatus: typeof suite.executionStatus === "string" ? suite.executionStatus : null,
      active: typeof suite.active === "boolean" ? suite.active : null,
      total: testCases.length,
      testCases,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as TestCasesData;
    ui.table(
      ["Property", "Value"],
      [
        ["Method UUID", data.uuid],
        ["Suite ID", data.testSuiteId ?? "(none)"],
        ["Active", data.active === null ? "" : data.active ? "Yes" : "No"],
        ["Last Execution Status", data.executionStatus ?? "(none)"],
        ["Test Cases", data.total],
      ],
    );
    if (data.testCases.length > 0) {
      ui.section("Test Cases");
      ui.table(
        ["ID", "Name", "Active", "Inputs", "Assertions"],
        data.testCases.map(c => [c.id, c.name, c.active ? "Yes" : "No", c.inputCount, c.assertionCount]),
      );
    }
  },
};

export default command;
