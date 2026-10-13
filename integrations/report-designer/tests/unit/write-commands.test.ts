// `rd create`, `rd save`, `rd archive` over the fake server: datasource
// resolution, the confirmation gate, the backup, the conflict check, the
// display settings a spec leaves out, and read-back verification.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { respond, runCommand, scratchDir, type RecordedRequest } from "@belzabar/core/testing";
import archive from "../../commands/archive/index";
import create from "../../commands/create/index";
import save from "../../commands/save/index";
import { RD_BACKUP_DIR } from "../../lib/write";
import { CATEGORY, COLUMNS, DS, fakeRdEnv, FILTER, RD_ENV, REPORT_ID } from "./fake-rd";

const rd = fakeRdEnv();
afterEach(() => rd.restore());

function specFile(over: Record<string, unknown> = {}): string {
  const path = join(scratchDir("rd-spec"), "spec.json");
  const spec = {
    format: "belz.rd.report/1",
    title: "Orders by day",
    description: "Daily totals",
    dataSource: { category: CATEGORY.name, method: DS.label },
    columns: COLUMNS,
    filters: [FILTER],
    summaries: [],
    ...over,
  };
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

const writes = (method: string) => rd.ff.requests.filter((q) => q.method === method);
const sentConfig = () => JSON.parse((writes("PUT").at(-1)!.json() as { configuration: string }).configuration);

describe("rd create", () => {
  test("needs --env; --llm without --yes is RD_CONFIRMATION_REQUIRED and writes nothing", async () => {
    rd.install();
    expect((await runCommand(create, ["--spec", specFile()])).envelope?.error?.code).toBe("ENV_REQUIRED_FOR_WRITE");
    expect((await runCommand(create, ["--spec", specFile()], { env: RD_ENV })).envelope?.error?.code).toBe("RD_CONFIRMATION_REQUIRED");
    expect(writes("POST")).toHaveLength(0);
  });

  test("--dry-run resolves the datasource and creates nothing", async () => {
    rd.install();
    const r = await runCommand(create, ["--spec", specFile(), "--dry-run"], { env: RD_ENV });
    expect(r.envelope?.data).toMatchObject({ dryRun: true, id: null, dataSource: { id: DS.id, categoryUuid: CATEGORY.uuid } });
    expect(writes("POST")).toHaveLength(0);
  });

  test("POST, title PATCH, configuration PUT with this env's ids, verified", async () => {
    rd.install();
    const r = await runCommand(create, ["--spec", specFile({ title: "New one" }), "--yes"], { env: RD_ENV });
    expect(r.envelope?.error ?? null).toBeNull();
    expect(r.envelope?.data).toMatchObject({ id: rd.nextId, title: "New one", mismatches: [] });
    expect(writes("PATCH")[0]!.json()).toEqual({ title: "New one", description: "Daily totals" });
    expect(sentConfig()).toMatchObject({ name: "New one", dataSourceId: DS.id, dataSourceCategoryUuid: CATEGORY.uuid, filterConfig: 0 });
    expect(rd.reports.get(rd.nextId)!.title).toBe("New one");
  });

  test("an unknown datasource fails before anything is created", async () => {
    rd.install();
    const r = await runCommand(create, ["--spec", specFile({ dataSource: { category: CATEGORY.name, method: "nope" } }), "--yes"], { env: RD_ENV });
    expect(r.envelope?.error?.code).toBe("RD_DATASOURCE_NOT_FOUND");
    expect(writes("POST")).toHaveLength(0);
  });

  test("an invalid spec is RD_SPEC_INVALID; a missing file RD_SPEC_UNREADABLE", async () => {
    rd.install();
    expect((await runCommand(create, ["--spec", specFile({ columns: [] }), "--dry-run"], { env: RD_ENV })).envelope?.error?.code).toBe("RD_SPEC_INVALID");
    expect((await runCommand(create, ["--spec", "/nonexistent/x.json", "--dry-run"], { env: RD_ENV })).envelope?.error?.code).toBe("RD_SPEC_UNREADABLE");
  });
});

describe("rd save", () => {
  test("--dry-run lists the changes and writes nothing", async () => {
    rd.install();
    const r = await runCommand(save, [REPORT_ID, "--spec", specFile({ filters: [] }), "--dry-run"], { env: RD_ENV });
    expect(r.envelope?.data).toMatchObject({ dryRun: true, changed: true, changes: ["filters: 1 → 0 (changed)"], backup: null });
    expect(writes("PUT")).toHaveLength(0);
    expect(rd.reports.get(REPORT_ID)!.executions).toBe(0);
  });

  test("backs up, keeps the current display settings, writes and verifies", async () => {
    rd.install();
    const r = await runCommand(save, [REPORT_ID, "--spec", specFile({ filters: [] }), "--yes"], { env: RD_ENV });
    expect(r.envelope?.error ?? null).toBeNull();
    const d = r.envelope?.data as { backup: string; mismatches: string[]; displayFromCurrent: boolean };
    expect(d.mismatches).toEqual([]);
    expect(d.displayFromCurrent).toBe(true);
    // the spec had no display settings: the report's own (bottom, 1) are kept
    expect(sentConfig()).toMatchObject({ filters: [], filterConfig: 1, summaryPosition: { value: "bottom" } });
    expect(d.backup.startsWith(join(RD_BACKUP_DIR, RD_ENV))).toBe(true);
    const backup = JSON.parse(readFileSync(d.backup, "utf8"));
    expect(backup.filters).toEqual([FILTER]);
    expect(backup.dataSource).toEqual({ category: CATEGORY.name, method: DS.label });
    // the title did not change: no PATCH
    expect(writes("PATCH")).toHaveLength(0);
  });

  test("a spec equal to the saved definition writes nothing", async () => {
    rd.install();
    const r = await runCommand(save, [REPORT_ID, "--spec", specFile({ filterConfig: 1, summaryPosition: { label: "Show summaries at bottom", value: "bottom" } }), "--yes"], {
      env: RD_ENV,
    });
    expect(r.envelope?.data).toMatchObject({ changed: false, backup: null });
    expect(writes("PUT")).toHaveLength(0);
  });

  test("a definition changed after it was read is RD_CONFLICT, nothing written", async () => {
    let v3Reads = 0;
    rd.install([
      {
        method: "GET",
        url: /\/rest\/api\/v3\/reports\?reportId=/,
        response: (req: RecordedRequest) => {
          v3Reads++;
          const r = rd.reports.get(REPORT_ID)!;
          // 1: readReport, 2: fingerprint before the confirmation, 3: fingerprint before the write
          if (v3Reads === 3) r.configuration = { ...r.configuration, description: "changed by someone else" };
          return [{ id: r.id, name: r.configuration.name, description: r.configuration.description, columns: r.configuration.columns, filters: r.configuration.filters, summaries: [], dataSourceId: DS.id, dataSourceCategoryUuid: CATEGORY.uuid, filterRequired: false, url: req.url }];
        },
      },
    ]);
    const r = await runCommand(save, [REPORT_ID, "--spec", specFile({ filters: [] }), "--yes"], { env: RD_ENV });
    expect(r.envelope?.error?.code).toBe("RD_CONFLICT");
    expect(writes("PUT")).toHaveLength(0);
  });

  test("a read-back that differs is RD_VERIFY_FAILED (with the data)", async () => {
    rd.install([
      {
        method: "PUT",
        url: /\/rest\/api\/v2\/reports\/[0-9a-f]{32}/,
        response: () => respond({ status: 200, json: {} }), // accepted but not stored
      },
    ]);
    const r = await runCommand(save, [REPORT_ID, "--spec", specFile({ filters: [] }), "--yes"], { env: RD_ENV });
    expect(r.envelope?.error?.code).toBe("RD_VERIFY_FAILED");
    expect((r.envelope?.data as { mismatches: string[] }).mismatches).toEqual(["filters: 0 → 1 (changed)"]);
  });
});

describe("rd archive", () => {
  test("archives, restores, and leaves a report already in that state alone", async () => {
    rd.install();
    const a = await runCommand(archive, [REPORT_ID, "--yes"], { env: RD_ENV });
    expect(a.envelope?.data).toMatchObject({ before: "ACTIVE", status: "ARCHIVED", changed: true });
    expect(writes("PATCH")[0]!.url).toContain("?execute=true");
    expect(writes("PATCH")[0]!.json()).toEqual({ reportStatus: "ARCHIVED" });
    const again = await runCommand(archive, [REPORT_ID, "--yes"], { env: RD_ENV });
    expect(again.envelope?.data).toMatchObject({ changed: false });
    const back = await runCommand(archive, [REPORT_ID, "--restore", "--yes"], { env: RD_ENV });
    expect(back.envelope?.data).toMatchObject({ before: "ARCHIVED", status: "ACTIVE" });
    expect(writes("PATCH")).toHaveLength(2);
  });
});

test("backups land under the test BELZ_HOME only", () => {
  expect(RD_BACKUP_DIR.startsWith(process.env.BELZ_HOME!)).toBe(true);
  if (existsSync(RD_BACKUP_DIR)) expect(readdirSync(RD_BACKUP_DIR)).toContain(RD_ENV);
});
