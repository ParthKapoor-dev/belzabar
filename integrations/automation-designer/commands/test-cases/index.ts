import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { resolveMethodRef } from "@belzabar/core/platform";
import { loadTestSuite, type TestSuiteSummary } from "../../lib/test-suite";

interface TestCasesArgs {
  uuid: string;
}

type TestCasesData = TestSuiteSummary;

export const args = defineArgs({
  command: "belz ad test-cases",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: {},
});

const command: CommandModule<TestCasesArgs, TestCasesData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { uuid: positionals.uuid };
  },
  async execute({ uuid: uuidArg }) {
    const uuid = resolveMethodRef(uuidArg);
    return ok<TestCasesData>(await loadTestSuite(uuid));
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
