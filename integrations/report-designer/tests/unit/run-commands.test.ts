// `rd run` and `rd download`: they run the report as saved (its env-local
// datasource ids), need --env, and turn the server's shapes into rows / a file.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import download from "../../commands/download/index";
import run from "../../commands/run/index";
import { CATEGORY, DS, fakeRdEnv, RD_ENV, REPORT_ID, storedReport } from "./fake-rd";

const rd = fakeRdEnv();
afterEach(() => rd.restore());

describe("rd run", () => {
  test("needs --env", async () => {
    rd.install();
    const r = await runCommand(run, [REPORT_ID]);
    expect(r.envelope?.error?.code).toBe("ENV_REQUIRED_FOR_WRITE");
    expect(rd.reports.get(REPORT_ID)!.executions).toBe(0);
  });

  test("runs the saved definition and returns rows keyed by column", async () => {
    rd.install();
    const r = await runCommand(run, [REPORT_ID, "--limit", "5", "--count"], { env: RD_ENV });
    expect(r.envelope?.error ?? null).toBeNull();
    expect(r.envelope?.data).toMatchObject({
      columns: ["Day", "Total"],
      rows: [
        { Day: "2026-01-01", Total: "5" },
        { Day: "2026-01-02", Total: "7" },
      ],
      returned: 2,
      totalRows: 2,
    });
    const sent = JSON.parse(rd.lastRun!);
    expect(sent).toMatchObject({ dataSourceId: DS.id, dataSourceCategoryUuid: CATEGORY.uuid, name: "Orders by day" });
    expect(sent.filters).toHaveLength(1);
    expect(rd.ff.requests.find((q) => q.method === "POST")!.url).toContain("offset=0&limit=5");
  });

  test("a report without a datasource is RD_NO_DATASOURCE, before any run", async () => {
    rd.reports.set(REPORT_ID, storedReport({ configuration: {} }));
    rd.install();
    const r = await runCommand(run, [REPORT_ID], { env: RD_ENV });
    expect(r.envelope?.error?.code).toBe("RD_NO_DATASOURCE");
    expect(rd.reports.get(REPORT_ID)!.executions).toBe(0);
  });
});

describe("rd download", () => {
  test("queues the export, polls until ready and saves the file", async () => {
    rd.install();
    rd.exportPolls = 1;
    const out = join(scratchDir("rd-dl"), "r.csv");
    const r = await runCommand(download, [REPORT_ID, "--out", out], { env: RD_ENV });
    expect(r.envelope?.data).toMatchObject({ format: "csv", requestId: "req1", emailed: false, path: out });
    expect(readFileSync(out, "utf8")).toBe("Day,Total\n2026-01-01,5\n");
    const fileGet = rd.ff.requests.find((q) => q.url.startsWith("https://files.example.test"))!;
    expect(fileGet.headers["authorization"]).toBeUndefined();
    expect(rd.ff.requests.find((q) => q.url.includes("/content?"))!.url).toContain("format=CSV");
    const poll = rd.ff.requests.find((q) => q.url.includes("/reports/download/"))!;
    expect(poll.headers["content-type"]).toBe("application/json");
  });

  test("xlsx maps to the server's XL format", async () => {
    rd.install();
    const out = join(scratchDir("rd-dl"), "r.xlsx");
    await runCommand(download, [REPORT_ID, "--format", "xlsx", "-o", out], { env: RD_ENV });
    expect(rd.ff.requests.find((q) => q.url.includes("/content?"))!.url).toContain("format=XL");
  });
});
