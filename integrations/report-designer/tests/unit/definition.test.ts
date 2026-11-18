// Spec validation, configuration building and change summaries (pure), and
// report-id parsing.
import { describe, expect, test } from "bun:test";
import { errorCode, thrownCliError } from "@belzabar/core/testing";
import { DEFAULT_SUMMARY_POSITION, parseSpec, SPEC_FORMAT, specChanges, toConfiguration, type ReportSpec } from "../../lib/definition";
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

const specObj = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...spec, ...over });

describe("parseSpec", () => {
  test("a valid spec round-trips", () => {
    const s = parseSpec(specObj({ description: "d", filterConfig: 2, isFilterRequired: true }));
    expect(s.title).toBe("Orders by day");
    expect(s.dataSource).toEqual({ category: "Reports-Test", method: "orders_by_day" });
    expect(s.filterConfig).toBe(2);
    expect(s.isFilterRequired).toBe(true);
  });

  test("lists every problem at once", () => {
    const err = thrownCliError(() =>
      parseSpec({ title: " ", dataSource: { category: "x" }, columns: [{ id: "1" }, { id: "1", name: "b" }], filters: [{ columnId: "9" }], filterConfig: 5 }),
    );
    expect(err.code).toBe("RD_SPEC_INVALID");
    const problems = (err.details as { problems: string[] }).problems;
    expect(problems).toContain("title: a non-empty string is required");
    expect(problems.some((p) => p.startsWith("dataSource:"))).toBe(true);
    expect(problems).toContain("columns[0]: id and name are required");
    expect(problems).toContain("columns[1]: duplicate id 1");
    expect(problems).toContain("filters[0]: columnId 9 is not one of the columns");
    expect(problems).toContain("filterConfig: must be 0, 1 or 2");
  });

  test("an unknown format and an empty column list are rejected", () => {
    expect(errorCode(() => parseSpec(specObj({ format: "other/2" })))).toBe("RD_SPEC_INVALID");
    expect(errorCode(() => parseSpec(specObj({ columns: [], filters: [] })))).toBe("RD_SPEC_INVALID");
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
  test("merges onto the stored configuration: unnamed keys survive, named ones are replaced", () => {
    const base = { name: "Old", description: "gone", reportStatus: "ACTIVE", downloadFilename: "Old_<timestamp:yyyy>", filterConfig: 2, extra: [1] };
    const kept = JSON.parse(toConfiguration(spec, { id: "501", categoryUuid: null }, base));
    expect(kept).toMatchObject({ name: "Orders by day", reportStatus: "ACTIVE", downloadFilename: "Old_<timestamp:yyyy>", filterConfig: 0, extra: [1] });
    expect(kept.description).toBeUndefined();
    expect(JSON.parse(toConfiguration({ ...spec, downloadFilename: "New" }, { id: "501", categoryUuid: null }, base)).downloadFilename).toBe("New");
    expect("downloadFilename" in JSON.parse(toConfiguration({ ...spec, downloadFilename: "" }, { id: "501", categoryUuid: null }, base))).toBe(false);
  });
  test("keeps exact display settings when the spec has them", () => {
    const cfg = JSON.parse(toConfiguration({ ...spec, filterConfig: 2, summaryPosition: { value: "bottom" } }, { id: "1", categoryUuid: "c" }));
    expect(cfg.filterConfig).toBe(2);
    expect(cfg.summaryPosition).toEqual({ value: "bottom" });
  });
});

describe("specChanges", () => {
  const base = parseSpec(specObj()) as ReportSpec;
  test("no change → empty", () => expect(specChanges(base, base)).toEqual([]));
  test("title, datasource, columns and filters", () => {
    const after = parseSpec(
      specObj({
        title: "Orders",
        dataSource: { category: "Reports-Test", method: "orders_v2" },
        columns: [COLUMNS[0], { id: "333", name: "Count", type: "NUMBER" }],
        filters: [],
      }),
    );
    expect(specChanges(base, after)).toEqual([
      'title: "Orders by day" → "Orders"',
      "datasource: Reports-Test/orders_by_day → Reports-Test/orders_v2",
      "column added: Count",
      "column removed: Total",
      "filters: 1 → 0 (changed)",
    ]);
  });
  test("a pure reorder is reported", () => {
    expect(specChanges(base, parseSpec(specObj({ columns: [COLUMNS[1], COLUMNS[0]] })))).toEqual(["columns reordered: Total, Day"]);
  });
  test("a reorder is reported next to other column changes; adding or removing alone is not a reorder (G2)", () => {
    const sorted = { sortBy: "ASC", ...COLUMNS[0] };
    const third = { id: "333", name: "Count", type: "NUMBER" };
    expect(specChanges(base, parseSpec(specObj({ columns: [COLUMNS[1], sorted] })))).toEqual(["column changed: Day", "columns reordered: Total, Day"]);
    expect(specChanges(base, parseSpec(specObj({ columns: [third, COLUMNS[0], COLUMNS[1]] })))).toEqual(["column added: Count"]);
    expect(specChanges(base, parseSpec(specObj({ columns: [COLUMNS[0]] })))).toEqual(["column removed: Total"]);
  });
  test("key order does not matter; a new key (sortBy) does (G1)", () => {
    const reKeyed = COLUMNS.map((c) => Object.fromEntries(Object.entries(c).reverse()));
    const filter = Object.fromEntries(Object.entries(FILTER).reverse());
    expect(specChanges(base, parseSpec(specObj({ columns: reKeyed, filters: [filter] })))).toEqual([]);
    expect(specChanges(base, parseSpec(specObj({ columns: [{ ...COLUMNS[0], sortBy: "DESC" }, COLUMNS[1]] })))).toEqual(["column changed: Day"]);
  });
});
