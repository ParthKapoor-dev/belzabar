import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

interface TestReportArgs {}

interface TestReportData {
  report: unknown;
}

export const args = defineArgs({
  command: "belz ad test-report",
  flags: { ...AD_COMMON_FLAGS },
});

const command: CommandModule<TestReportArgs, TestReportData> = {
  schema: "ad.test-report",
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    resolveAdCommon(flags, "testCase", "test-report");
    return {};
  },
  async execute() {
    const report = await adApi.getTestSuiteReport();
    return ok<TestReportData>({ report });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as TestReportData;
    ui.section("Test Suite Report");
    ui.object(data.report);
  },
};

export default command;
