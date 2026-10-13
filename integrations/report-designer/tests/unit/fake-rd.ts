// A fake Report Designer server for command tests: one env with a temp config,
// silenced stderr, and an in-memory report store behind fakeFetch. Shapes follow
// the live wire (lib/README.md); ids and names are made up.
//
//   const rd = fakeRdEnv();
//   afterEach(() => rd.restore());
//   rd.install();                       // default routes over rd.reports
//   await runCommand(cmd, argv, { env: RD_ENV });
//   rd.ff.calls("PUT", "/rest/api/v2/reports/*")

import { spyOn } from "bun:test";
import { fakeFetch, respond, withTempEnvConfig, type FakeFetch, type RecordedRequest, type TempEnvConfig } from "@belzabar/core/testing";
import type { Obj } from "@belzabar/core";

export const RD_ENV = "t-rd";
export const RD_ENV_2 = "t-rd2";
export const REPORT_ID = "0123456789abcdef0123456789abcdef";
export const CATEGORY = { id: 7, name: "Reports-Test", uuid: "aaaabbbbccccddddeeeeffff00001111", aliasName: ["Reports-Test"] };
export const DS = { type: "SERVICE", id: "501", label: "orders_by_day", description: "Orders per day" };

export const COLUMNS: Obj[] = [
  { id: "111", data: [], name: "Day", type: "DATE", label: "Day", width: 150, starred: false, filterable: true, reportable: true },
  { id: "222", data: [], name: "Total", type: "NUMBER", label: "Total", width: 150, starred: false, filterable: false, reportable: true },
];
export const FILTER: Obj = {
  value: "2026-01-01",
  column: COLUMNS[0],
  applied: true,
  operand: { id: 6, type: "equal_to", label: "equal to", dataType: "DATE", uiComponent: "DATE" },
  columnId: "111",
  selected: true,
  operandId: 6,
  isValueInValid: false,
  isOperandInValid: false,
};

export interface StoredReport {
  id: string;
  title: string;
  status: string;
  configuration: Obj;
  executions: number;
}

export function storedReport(over: Partial<StoredReport> = {}): StoredReport {
  return {
    id: REPORT_ID,
    title: "Orders by day",
    status: "ACTIVE",
    executions: 0,
    configuration: {
      name: "Orders by day",
      description: "Daily totals",
      dataSourceId: DS.id,
      dataSourceType: "SERVICE",
      dataSourceCategoryUuid: CATEGORY.uuid,
      columns: COLUMNS,
      filters: [FILTER],
      summaries: [],
      summaryPosition: { label: "Show summaries at bottom", value: "bottom" },
      filterConfig: 1,
      isFilterRequired: false,
    },
    ...over,
  };
}

export interface FakeRdEnv {
  readonly ff: FakeFetch;
  reports: Map<string, StoredReport>;
  /** Next id POST /reports hands out. */
  nextId: string;
  /** The configuration string of the last run / export request. */
  lastRun: string | null;
  /** How many export polls answer PROCESSING before the file is ready. */
  exportPolls: number;
  install(extra?: Parameters<typeof fakeFetch>[0]): FakeFetch;
  restore(): void;
}

const v2 = "/rest/api/v2/reports";

function basic(r: StoredReport): Obj {
  return {
    id: r.id,
    versionId: 10,
    ownerId: 2,
    reportStatus: r.status,
    engineType: "IN_HOUSE",
    dataSourceName: String(DS.label),
    title: r.title,
    dataSourceType: "SERVICE",
    serialId: 42,
    createdAt: "2026-01-01 10:00:00",
    updatedAt: "2026-01-02 10:00:00",
    lastExecutedAt: "2026-01-03 10:00:00",
    permissions: [],
    role: "NO_ROLE",
  };
}

function v3(r: StoredReport): Obj {
  const c = r.configuration;
  return {
    id: r.id,
    name: c.name,
    description: c.description,
    columns: c.columns,
    filters: c.filters,
    summaries: c.summaries,
    dataSourceId: c.dataSourceId,
    dataSourceCategoryUuid: c.dataSourceCategoryUuid,
    contributors: { view: { contributors: [], groupContributors: [] }, edit: { contributors: [], groupContributors: [] } },
    createdBy: 2,
    filterRequired: c.isFilterRequired,
  };
}

const idOf = (url: string) => /[/=]([0-9a-f]{32})(?:[/?&]|$)/.exec(url)?.[1] ?? "";

export function fakeRdEnv(opts: { envs?: string[] } = {}): FakeRdEnv {
  let cfg: TempEnvConfig | null = null;
  let ff: FakeFetch | null = null;
  let quiet: { mockRestore(): void } | null = null;
  const notFound = () => respond({ status: 404, json: { errorMessage: "Report not found" } });
  const self: FakeRdEnv = {
    reports: new Map([[REPORT_ID, storedReport()]]),
    nextId: "fedcba9876543210fedcba9876543210",
    lastRun: null,
    exportPolls: 0,
    get ff() {
      if (!ff) throw new Error("fakeRdEnv: install() has not run");
      return ff;
    },
    install(extra = []) {
      const envs = Object.fromEntries((opts.envs ?? [RD_ENV]).map((e) => [e, { url: `https://${e}.example.test` }]));
      cfg ??= withTempEnvConfig({ envs, activeEnv: (opts.envs ?? [RD_ENV])[0] });
      quiet ??= spyOn(process.stderr, "write").mockImplementation(() => true);
      ff?.restore();
      const get = (req: RecordedRequest) => self.reports.get(idOf(req.url));
      ff = fakeFetch([
        ...(extra as unknown[]),
        { method: "GET", url: /\/rest\/api\/v2\/reports\/datasources\/category$/, response: [CATEGORY] },
        { method: "GET", url: /\/rest\/api\/v2\/reports\/datasources\?/, response: [DS] },
        { method: "GET", url: /\/rest\/api\/v2\/reports\/count$/, response: { TOTAL: self.reports.size, ARCHIVED: 0 } },
        { method: "GET", url: /\/rest\/api\/v2\/reports\?/, response: () => [...self.reports.values()].map(basic) },
        { method: "GET", url: /\/rest\/api\/v3\/reports\?reportId=/, response: (req: RecordedRequest) => (get(req) ? [v3(get(req)!)] : notFound()) },
        {
          method: "GET",
          url: /\/rest\/api\/v2\/reports\/[0-9a-f]{32}\?apiInfoLevel=BASIC/,
          response: (req: RecordedRequest) => (get(req) ? basic(get(req)!) : respond({ status: 500, json: { errorMessage: "NPE" } })),
        },
        {
          method: "GET",
          url: /\/rest\/api\/v2\/reports\/[0-9a-f]{32}\?apiInfoLevel=DETAILED/,
          response: (req: RecordedRequest) => {
            const r = get(req);
            if (!r) return notFound();
            r.executions++;
            return { ...basic(r), configuration: JSON.stringify(r.configuration), data: { columns: [] } };
          },
        },
        {
          method: "POST",
          url: /\/rest\/api\/v2\/reports\/count\/[0-9a-f]{32}/,
          response: (req: RecordedRequest) => {
            const r = get(req);
            if (!r) return notFound();
            r.executions++;
            return { totalRows: 2 };
          },
        },
        {
          method: "POST",
          url: /\/rest\/api\/v2\/reports\/[0-9a-f]{32}\/content\?format=/,
          response: (req: RecordedRequest) => {
            const r = get(req);
            if (!r) return notFound();
            r.executions++;
            self.lastRun = (req.json() as { configuration: string }).configuration;
            return respond({ status: 202, json: { requestId: "req1", queued: true, pollTimeInSeconds: 1 } });
          },
        },
        {
          method: "GET",
          url: /\/rest\/api\/reports\/download\/req1$/,
          response: () => (self.exportPolls-- > 0 ? { status: "PROCESSING" } : { next: "false", isEmail: "false", fileURL: "https://files.example.test/dl/r.csv?sig=1" }),
        },
        { method: "GET", url: "https://files.example.test/dl/r.csv?sig=1", response: respond({ status: 200, text: "Day,Total\n2026-01-01,5\n" }) },
        {
          method: "POST",
          url: /\/rest\/api\/v2\/reports\/[0-9a-f]{32}\?/,
          response: (req: RecordedRequest) => {
            const r = get(req);
            if (!r) return notFound();
            const cfg = JSON.parse((req.json() as { configuration: string }).configuration);
            if (!cfg.dataSourceId) return respond({ status: 400, json: { errorMessage: "Invalid input provided for field dataSourceId", errorCode: 115 } });
            r.executions++;
            self.lastRun = (req.json() as { configuration: string }).configuration;
            return {
              ...basic(r),
              reportStatus: "ADHOC",
              resultantRows: 2,
              data: {
                columns: [
                  { ...COLUMNS[0], data: ["2026-01-01", "2026-01-02"] },
                  { ...COLUMNS[1], data: ["5", "7"] },
                ],
                summaryData: [],
              },
            };
          },
        },
        {
          method: "POST",
          url: `${v2}`,
          response: () => {
            const r = storedReport({ id: self.nextId, title: "Report, 01/01/2026 10:00:00 AM", configuration: {} });
            self.reports.set(r.id, r);
            return basic(r);
          },
        },
        {
          method: "PATCH",
          url: /\/rest\/api\/v2\/reports\/[0-9a-f]{32}/,
          response: (req: RecordedRequest) => {
            const r = get(req);
            if (!r) return notFound();
            const body = req.json() as Obj;
            if (typeof body.title === "string") r.title = body.title;
            if (typeof body.reportStatus === "string") r.status = body.reportStatus;
            if (typeof body.description === "string") r.configuration = { ...r.configuration, description: body.description };
            return { ...basic(r), configuration: JSON.stringify(r.configuration) };
          },
        },
        {
          method: "PUT",
          url: /\/rest\/api\/v2\/reports\/[0-9a-f]{32}/,
          response: (req: RecordedRequest) => {
            const r = get(req);
            if (!r) return notFound();
            r.configuration = JSON.parse((req.json() as { configuration: string }).configuration);
            return { ...basic(r), configuration: JSON.stringify(r.configuration) };
          },
        },
        {
          method: "GET",
          url: /\/rest\/api\/automate\/dependent\/report\?methodId=/,
          response: () => [...self.reports.values()].map((r) => ({ uuid: r.id, reportName: r.title })),
        },
      ] as Parameters<typeof fakeFetch>[0]).install();
      return ff;
    },
    restore() {
      ff?.restore();
      cfg?.restore();
      quiet?.mockRestore();
      ff = cfg = quiet = null;
      self.reports = new Map([[REPORT_ID, storedReport()]]);
      self.lastRun = null;
      self.exportPolls = 0;
    },
  };
  return self;
}
