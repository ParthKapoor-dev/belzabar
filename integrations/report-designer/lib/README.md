# report-designer/lib

The Report Designer client and definitions, imported as `@belzabar/rd/lib/<file>`.

| File | Contents |
|---|---|
| `api.ts` | Every RD request (on core `apiFetch`): reports, runs, exports, datasources, the AD → report lookup; `RD_*` error mapping |
| `datasource.ts` | `{category, method}` ↔ env-local `dataSourceId` / `dataSourceCategoryUuid` (`resolveDataSource`, `describeDataSource`), per-env memo (`forgetDataSources` after a miss) |
| `definition.ts` | `readReport` (side-effect free unless `exact`), the spec (`parseSpec`, `readSpecFile`, `SPEC_FORMAT`), `toConfiguration`, `savedConfiguration` (the report's own ids, for runs), `specChanges` |
| `write.ts` | The write pipeline (PATCH / PUT / read-back): `createReport`, `planSave` / `applySave` (diff, backup to `RD_BACKUP_DIR`, conflict check, write) |
| `confirm.ts` | `requireConfirmation` (`RD_CONFIRMATION_REQUIRED` / `RD_USER_ABORT`), `logIntent` (`[belz rd write]`) |
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
| `createEmptyReport` | `POST /rest/api/v2/reports` (no body) | creates "Report, <date>" without contributors |
| `patchReport` | `PATCH /rest/api/v2/reports/{id}[?execute=true]` `{title?, description?, reportStatus?}` | updates metadata; the saved configuration is kept |
| `saveConfiguration` | `PUT /rest/api/v2/reports/{id}` `{configuration}` | replaces the definition |
| `runReport` / `countRows` | `POST /rest/api/v2/reports/{id}` / `…/count/{id}` `{configuration}` | **runs the datasource** |
| `requestExport` / `pollExport` | `POST …/{id}/content?format=CSV\|XL\|PDF`, then `GET /rest/api/reports/download/{requestId}` (needs a JSON Content-Type) | **runs the datasource** |
| `listDatasourceCategories` / `listDatasources` | `GET …/datasources/category`, `GET …/datasources?apiInfoLevel=BASIC&categoryUuid=` | none |
| `dependentReports` | `GET /rest/api/automate/dependent/report?methodId=` (draft or published uuid) | none |
| `getChainById` | `GET /rest/api/automation/chain/{chainId}` (an AD route: name, category, state) | none |

Not used: `GET …/datasources/{chainId}?apiInfoLevel=MEDIUM` (schema discovery; it runs the
method) and `DELETE …/{id}`.

## Reading a report (`definition.ts`)

`readReport` combines the v3 definition and the BASIC record, so it never runs anything. The
two display settings only the DETAILED read returns (`summaryPosition`, `filterConfig`) are
listed in `unread` unless `exact` is set. The method name falls back to the record's
`dataSourceName` when the chain id is no longer listed (e.g. the method was unpublished).

Older reports were saved without `dataSourceCategoryUuid`; `describeDataSource` then names the
datasource from the AD chain itself (`getChainById`), and runs send the configuration back
without it, as saved.

## Datasources (`datasource.ts`)

A datasource is a published AD method; only published methods are listed, by category. A
spec's `{category, method}` resolves by exact method name (then case-insensitive), category by
name, alias or uuid. Two published methods with the same name in one category are
`RD_DATASOURCE_AMBIGUOUS`.

## Writes (`write.ts`)

Title and description live on the record (PATCH), the rest in the configuration (PUT); a
PATCH keeps the saved configuration (verified live). `writeSpec` re-reads the v3 definition
right before writing and compares it with the fingerprint taken before the confirmation
(`RD_CONFLICT`), then reads back through `readReport` and lists differences with
`specChanges`. Display settings are compared only when both sides know them.

`planSave` reads the report with `exact` (it runs once) unless it is a dry run, so the display
settings can be compared and kept when the spec leaves them out; `applySave` backs up, writes
and verifies. `rd save` and `rd copy --into` share them. The memoised datasource lists are
per env (keyed by env name), so `rd copy` resolves on the source and the target separately.

## Extending

New route: a function in `api.ts` built on `call` (it maps errors), a route in
[`../tests/unit/fake-rd.ts`](../tests/unit/fake-rd.ts), and a test.

Up: [package README](../README.md).
