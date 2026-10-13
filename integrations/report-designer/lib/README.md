# report-designer/lib

The Report Designer client and definitions, imported as `@belzabar/rd/lib/<file>`.

| File | Contents |
|---|---|
| `api.ts` | Every RD request (on core `apiFetch`): reports, runs, exports, datasources, the AD → report lookup; `RD_*` error mapping |
| `datasource.ts` | Env-local `dataSourceId` / `dataSourceCategoryUuid` → `{category, method}` (`describeDataSource`), category and datasource lists, per-env memo |
| `definition.ts` | `readReport` (side-effect free unless `exact`), the spec type (`SPEC_FORMAT`), `toConfiguration`, `savedConfiguration` (the report's own ids, for runs) |
| `report-id.ts` | `parseReportId` (id, dashed id or URL), `REPORT_ID_POSITIONAL` |
| `view.ts` | Compact column / filter / summary views for presenters |

## Routes (`api.ts`)

All verified against a live env; the RD web app uses the same calls.

| Call | Route | Side effects |
|---|---|---|
| `listReports` | `GET /rest/api/v2/reports?sortType=&searchTerm=&limit=&offset=` | none |
| `getReportBasic` | `GET /rest/api/v2/reports/{id}?apiInfoLevel=BASIC` (metadata; an unknown id is a 500) | none |
| `getReportDefinition` | `GET /rest/api/v3/reports?reportId={id}` (parsed definition; 404 when unknown) | none |
| `getReportDetailed` | `GET /rest/api/v2/reports/{id}?apiInfoLevel=DETAILED` (configuration string) | **runs the report** |
| `runReport` / `countRows` | `POST /rest/api/v2/reports/{id}` / `…/count/{id}` `{configuration}` | **runs the datasource** |
| `requestExport` / `pollExport` | `POST …/{id}/content?format=CSV\|XL\|PDF`, then `GET /rest/api/reports/download/{requestId}` (needs a JSON Content-Type) | **runs the datasource** |
| `listDatasourceCategories` / `listDatasources` | `GET …/datasources/category`, `GET …/datasources?apiInfoLevel=BASIC&categoryUuid=` | none |
| `dependentReports` | `GET /rest/api/automate/dependent/report?methodId=` (draft or published uuid) | none |

Not used: `GET …/datasources/{chainId}?apiInfoLevel=MEDIUM` (schema discovery; it runs the
method) and `DELETE …/{id}`.

## Reading a report (`definition.ts`)

`readReport` combines the v3 definition and the BASIC record, so it never runs anything. The
two display settings only the DETAILED read returns (`summaryPosition`, `filterConfig`) are
listed in `unread` unless `exact` is set. The method name falls back to the record's
`dataSourceName` when the chain id is no longer listed (e.g. the method was unpublished).

## Datasources (`datasource.ts`)

A datasource is a published AD method; only published methods are listed, by category.
Categories are found by name, alias or uuid (case-insensitive).

## Extending

New route: a function in `api.ts` built on `call` (it maps errors), a route in
[`../tests/unit/fake-rd.ts`](../tests/unit/fake-rd.ts), and a test.

Up: [package README](../README.md).
