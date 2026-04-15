import { ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";

interface TestReportArgs {}

interface TestReportData {
  report: unknown;
}

const command: CommandModule<TestReportArgs, TestReportData> = {
  schema: "ad.test-report",
  parseArgs(args) {
    const { common } = parseAdCommonArgs(args, "testCase", "test-report");
    emitFallbackWarning(common, "test-report");
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
