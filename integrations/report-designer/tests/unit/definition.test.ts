// Configuration building (pure) and report-id parsing.
import { describe, expect, test } from "bun:test";
import { errorCode } from "@belzabar/core/testing";
import { DEFAULT_SUMMARY_POSITION, SPEC_FORMAT, toConfiguration, type ReportSpec } from "../../lib/definition";
import { parseReportId } from "../../lib/report-id";
import { COLUMNS, FILTER } from "./fake-rd";

const spec: ReportSpec = {
  format: SPEC_FORMAT,
  title: "Orders by day",
  dataSource: { category: "Reports-Test", method: "orders_by_day" },
  columns: COLUMNS,
  filters: [FILTER],
  summaries: [],
};

describe("parseReportId", () => {
  test("bare, dashed, upper case and URL forms", () => {
    expect(parseReportId("0123456789ABCDEF0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(parseReportId(" 01234567-89ab-cdef-0123-456789abcdef ")).toBe("0123456789abcdef0123456789abcdef");
    expect(parseReportId("https://dev.example.test/report-designer/report/0123456789abcdef0123456789abcdef?tab=1")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
  });
  test("anything else is RD_INVALID_ID", () => {
    expect(errorCode(() => parseReportId("report-7"))).toBe("RD_INVALID_ID");
    expect(errorCode(() => parseReportId("https://dev.example.test/report-designer/new"))).toBe("RD_INVALID_ID");
  });
});

describe("toConfiguration", () => {
  test("names the env-local datasource and fills the display defaults", () => {
    const cfg = JSON.parse(toConfiguration(spec, { id: "501", categoryUuid: "c-uuid" }));
    expect(cfg).toMatchObject({
      name: "Orders by day",
      dataSourceId: "501",
      dataSourceType: "SERVICE",
      dataSourceCategoryUuid: "c-uuid",
      filterConfig: 0,
      isFilterRequired: false,
      summaryPosition: DEFAULT_SUMMARY_POSITION,
    });
    expect(cfg.columns).toEqual(COLUMNS);
    expect(cfg.filters).toEqual([FILTER]);
  });
  test("keeps exact display settings when the spec has them", () => {
    const cfg = JSON.parse(toConfiguration({ ...spec, filterConfig: 2, summaryPosition: { value: "bottom" } }, { id: "1", categoryUuid: "c" }));
    expect(cfg.filterConfig).toBe(2);
    expect(cfg.summaryPosition).toEqual({ value: "bottom" });
  });
});
