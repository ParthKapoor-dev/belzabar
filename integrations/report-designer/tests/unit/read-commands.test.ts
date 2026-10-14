// The read commands over the fake RD server: nothing they do may run a report
// (only the opt-in --exact read does), and the datasource is named portably.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import datasources from "../../commands/datasources/index";
import exportCmd from "../../commands/export/index";
import find from "../../commands/find/index";
import show from "../../commands/show/index";
import uses from "../../commands/uses/index";
import { CATEGORY, COLUMNS, DS, fakeRdEnv, RD_ENV, REPORT_ID, storedReport } from "./fake-rd";

const rd = fakeRdEnv();
afterEach(() => rd.restore());

const data = <T>(r: { envelope: { data: unknown } | null }) => r.envelope!.data as T;

describe("rd show", () => {
  test("definition, datasource names and filters, without running the report", async () => {
    rd.install();
    const r = await runCommand(show, [REPORT_ID], { env: RD_ENV });
    expect(r.envelope?.ok).toBe(true);
    const d = data<any>(r);
    expect(d.title).toBe("Orders by day");
    expect(d.dataSource).toEqual({ id: DS.id, categoryUuid: CATEGORY.uuid, category: CATEGORY.name, method: DS.label });
    expect(d.columns.map((c: any) => c.name)).toEqual(["Day", "Total"]);
    expect(d.filters).toEqual([{ column: "Day", operator: "equal to", value: "2026-01-01", applied: true }]);
    expect(d.unread).toEqual(["summaryPosition", "filterConfig"]);
    expect(rd.reports.get(REPORT_ID)!.executions).toBe(0);
    expect(rd.ff.requests.some((q) => q.url.includes("DETAILED"))).toBe(false);
  });

  test("--exact reads the display settings (runs once) and needs --env", async () => {
    rd.install();
    const noEnv = await runCommand(show, [REPORT_ID, "--exact"]);
    expect(noEnv.envelope?.error?.code).toBe("ENV_REQUIRED_FOR_WRITE");
    const r = await runCommand(show, [REPORT_ID, "--exact"], { env: RD_ENV });
    expect(data<any>(r)).toMatchObject({ filterConfig: 1, summaryPosition: { value: "bottom" }, unread: [] });
    expect(rd.reports.get(REPORT_ID)!.executions).toBe(1);
  });

  test("unknown id → RD_NOT_FOUND; an unlisted chain id is named from the AD chain", async () => {
    rd.install();
    const missing = await runCommand(show, ["ffffffffffffffffffffffffffffffff"], { env: RD_ENV });
    expect(missing.envelope?.error?.code).toBe("RD_NOT_FOUND");
    rd.reports.set(REPORT_ID, storedReport({ configuration: { ...storedReport().configuration, dataSourceId: "999" } }));
    const r = await runCommand(show, [REPORT_ID], { env: RD_ENV });
    expect(data<any>(r).dataSource).toMatchObject({ id: "999", category: CATEGORY.name, method: "orders_by_day_old" });
    expect(r.envelope?.meta.warnings).toBeUndefined();
  });
});

describe("older reports without a category uuid", () => {
  test("the datasource is named from the AD chain, so export still writes a portable spec", async () => {
    const { dataSourceCategoryUuid: _, ...cfg } = storedReport().configuration;
    rd.reports.set(REPORT_ID, storedReport({ configuration: cfg }));
    rd.install();
    const r = await runCommand(exportCmd, [REPORT_ID], { env: RD_ENV });
    expect(data<any>(r).spec.dataSource).toEqual({ category: CATEGORY.name, method: DS.label });
    expect(rd.ff.requests.some((q) => q.url.endsWith(`/rest/api/automation/chain/${DS.id}`))).toBe(true);
  });
});

describe("rd export", () => {
  test("writes a portable spec (no env-local ids)", async () => {
    rd.install();
    const out = join(scratchDir("rd-export"), "r.json");
    const r = await runCommand(exportCmd, [REPORT_ID, "--out", out], { env: RD_ENV });
    expect(data<any>(r).path).toBe(out);
    const spec = JSON.parse(readFileSync(out, "utf8"));
    expect(spec).toMatchObject({ format: "wi-impl.rd.report/1", title: "Orders by day", description: "Daily totals", dataSource: { category: CATEGORY.name, method: DS.label } });
    expect(spec.columns).toEqual(COLUMNS);
    expect(JSON.stringify(spec)).not.toContain(CATEGORY.uuid);
    expect(spec.dataSourceId).toBeUndefined();
  });
});

describe("rd find / uses / datasources", () => {
  test("find hides archived rows unless --archived", async () => {
    rd.reports.set("11111111111111111111111111111111", storedReport({ id: "11111111111111111111111111111111", title: "Old", status: "ARCHIVED" }));
    rd.install();
    const r = await runCommand(find, ["orders"], { env: RD_ENV });
    expect(data<any>(r)).toMatchObject({ total: 1, hiddenArchived: 1 });
    expect(rd.ff.requests[0]!.url).toContain("searchTerm=orders");
    expect(rd.ff.requests[0]!.url).toContain("sortType=RECENTLY_EXECUTED");
    const all = await runCommand(find, ["--archived", "--sort", "created"], { env: RD_ENV });
    expect(data<any>(all).total).toBe(2);
  });

  test("uses lists reports by method uuid", async () => {
    rd.install();
    const r = await runCommand(uses, ["AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"], { env: RD_ENV });
    expect(data<any>(r).reports).toEqual([{ id: REPORT_ID, title: "Orders by day" }]);
    expect(rd.ff.requests.at(-1)!.url).toContain("methodId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("datasources: categories, then one category's methods", async () => {
    rd.install();
    const cats = await runCommand(datasources, [], { env: RD_ENV });
    expect(data<any>(cats).categories).toEqual([{ name: CATEGORY.name, uuid: CATEGORY.uuid }]);
    const ds = await runCommand(datasources, ["--category", "reports-test"], { env: RD_ENV });
    expect(data<any>(ds)).toMatchObject({ kind: "datasources", category: CATEGORY.name, datasources: [{ id: DS.id, method: DS.label }] });
    const none = await runCommand(datasources, ["--category", "nope"], { env: RD_ENV });
    expect(none.envelope?.error?.code).toBe("RD_DATASOURCE_CATEGORY_NOT_FOUND");
  });
});
