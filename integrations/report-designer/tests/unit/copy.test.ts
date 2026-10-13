// `rd copy`: read on the source env, datasource mapped by name to the target
// env's own ids, then create (or --into: the save pipeline) on the target.
import { afterEach, describe, expect, test } from "bun:test";
import { runCommand } from "@belzabar/core/testing";
import copy from "../../commands/copy/index";
import { CATEGORY_2, DS_2, fakeRdEnv, RD_ENV, RD_ENV_2, REPORT_ID, storedReport } from "./fake-rd";

const rd = fakeRdEnv({ envs: [RD_ENV, RD_ENV_2] });
afterEach(() => rd.restore());

const onTarget = (method: string) => rd.ff.requests.filter((q) => q.method === method && q.url.includes(`//${RD_ENV_2}.`));
const FROM = ["--from-env", RD_ENV];

describe("rd copy", () => {
  test("--dry-run maps the datasource to the target's ids and writes nothing", async () => {
    rd.install();
    const r = await runCommand(copy, [REPORT_ID, ...FROM, "--dry-run"], { env: RD_ENV_2 });
    expect(r.envelope?.error ?? null).toBeNull();
    expect(r.envelope?.data).toMatchObject({
      from: { env: RD_ENV, id: REPORT_ID, title: "Orders by day" },
      to: { env: RD_ENV_2, id: null, mode: "create" },
      dataSource: { id: DS_2.id, categoryUuid: CATEGORY_2.uuid },
      unread: ["summaryPosition", "filterConfig"],
    });
    expect(rd.ff.requests.some((q) => q.method !== "GET")).toBe(false);
    // the source was read on the source host, never run
    expect(rd.ff.requests.some((q) => q.url.includes(`//${RD_ENV}.`) && q.url.includes("/v3/reports"))).toBe(true);
    expect(rd.reports.get(REPORT_ID)!.executions).toBe(0);
  });

  test("creates the copy on the target with the target's datasource ids", async () => {
    rd.install();
    const r = await runCommand(copy, [REPORT_ID, ...FROM, "--title", "Orders (copy)", "--yes"], { env: RD_ENV_2 });
    expect(r.envelope?.error ?? null).toBeNull();
    expect(r.envelope?.data).toMatchObject({ to: { mode: "create", id: rd.nextId }, mismatches: [] });
    expect(onTarget("POST")).toHaveLength(1);
    const cfg = JSON.parse((onTarget("PUT")[0]!.json() as { configuration: string }).configuration);
    expect(cfg).toMatchObject({ name: "Orders (copy)", dataSourceId: DS_2.id, dataSourceCategoryUuid: CATEGORY_2.uuid });
    expect(rd.ff.requests.some((q) => q.method !== "GET" && q.url.includes(`//${RD_ENV}.`))).toBe(false);
  });

  test("--exact carries the display settings (runs the source once)", async () => {
    rd.install();
    await runCommand(copy, [REPORT_ID, ...FROM, "--exact", "--yes"], { env: RD_ENV_2 });
    const cfg = JSON.parse((onTarget("PUT")[0]!.json() as { configuration: string }).configuration);
    expect(cfg).toMatchObject({ filterConfig: 1, summaryPosition: { value: "bottom" } });
  });

  test("--into updates an existing target report through the save pipeline", async () => {
    const target = "abcdefabcdefabcdefabcdefabcdefab";
    rd.reports.set(target, storedReport({ id: target, title: "Orders by day", configuration: { ...storedReport().configuration, filters: [], dataSourceId: DS_2.id, dataSourceCategoryUuid: CATEGORY_2.uuid } }));
    rd.install();
    const r = await runCommand(copy, [REPORT_ID, ...FROM, "--into", target, "--yes"], { env: RD_ENV_2 });
    expect(r.envelope?.error ?? null).toBeNull();
    expect(r.envelope?.data).toMatchObject({ to: { mode: "update", id: target }, changes: ["filters: 0 → 1 (changed)"] });
    expect((r.envelope?.data as { backup: string }).backup).toContain(RD_ENV_2);
    expect(onTarget("POST").filter((q) => !q.url.includes("?"))).toHaveLength(0);
    expect(onTarget("PUT")).toHaveLength(1);
  });

  test("a datasource missing on the target stops before any write, pointing at migrate", async () => {
    rd.install([{ method: "GET", url: new RegExp(`//${RD_ENV_2}\\..*datasources\\?`), response: [] }]);
    const r = await runCommand(copy, [REPORT_ID, ...FROM, "--yes"], { env: RD_ENV_2 });
    expect(r.envelope?.error?.code).toBe("RD_DATASOURCE_NOT_FOUND");
    expect(r.envelope?.error?.message).toContain("belz migrate run");
    expect(rd.ff.requests.some((q) => q.method !== "GET")).toBe(false);
  });

  test("same env is RD_SAME_ENV; --from-env is required", async () => {
    rd.install();
    expect((await runCommand(copy, [REPORT_ID, "--from-env", RD_ENV_2, "--yes"], { env: RD_ENV_2 })).envelope?.error?.code).toBe("RD_SAME_ENV");
    expect((await runCommand(copy, [REPORT_ID, "--yes"], { env: RD_ENV_2 })).envelope?.error?.code).toBe("MISSING_FROM_ENV");
  });
});
