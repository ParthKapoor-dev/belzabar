import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";

interface TestReportArgs {}

interface TestReportData {
  report: unknown;
  /** The report shows a run (tests completed/remaining, or results). */
  found: boolean;
  /** Set when nothing is reported: why, and what to use instead. */
  note?: string;
}

export const args = defineArgs({
  command: "belz ad test-report",
  flags: {},
});

// Live 2026-09-29: the route is not per chain, and it answered
// {testsCompleted:0, testsRemaining:0, results:null} before, during and after
// a `test-case run-suite` of a 2-case suite. All zeros means "nothing reported",
// never "0 tests ran / all passed" (CLI trial tr2).
export const NO_REPORT_NOTE =
  "No suite run is reported. This route is not scoped to a method and does not track `ad test-case run-suite` " +
  "(the server e-mails that report). Use `belz ad test-case run-suite <uuid> --wait` for per-case results.";

const nonEmpty = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" ? Object.keys(v).length > 0 : false;

/** Whether a report body shows any run at all. */
export function reportFound(report: unknown): boolean {
  if (report === null || typeof report !== "object") return false;
  const r = report as Record<string, unknown>;
  return Number(r.testsCompleted) > 0 || Number(r.testsRemaining) > 0 || nonEmpty(r.results) || nonEmpty(r.resultsPending);
}

const command: CommandModule<TestReportArgs, TestReportData> = {
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    return {};
  },
  async execute() {
    const report = await adApi.getTestSuiteReport();
    const found = reportFound(report);
    return ok<TestReportData>(found ? { report, found } : { report, found, note: NO_REPORT_NOTE });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as TestReportData;
    ui.section("Test Suite Report");
    if (data.note) ui.warn(data.note);
    ui.object(data.report);
  },
};

export default command;
