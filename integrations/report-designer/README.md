# @belzabar/rd

`belz rd …` — Report Designer: find and read reports without running them, run or download
them, export a report as a portable spec, list datasources, and find the reports an AD method
feeds.

## What a report is

A Report Designer report is a saved tabular view over one **published AD method** (its
datasource). The whole definition (columns, saved filters, summaries, display settings) is a
small JSON document the server stores as a string. There are no templates, no draft/publish
step, no version history (every save and run bumps a counter; last write wins) and no Jenkins
migration module.

The definition refers to its datasource by env-local ids: the published method's numeric chain
id and its category's uuid. belz names it portably as `{category, method}` and resolves the
ids on the env it talks to ([`lib/datasource.ts`](lib/datasource.ts)).

## Role in the monorepo

- Depends only on `@belzabar/core` (http, config, args, ids).
- `apps/cli` mounts [`registry.ts`](registry.ts) as the `rd` namespace; it is env-aware like
  `ad` and `pd` (`--env`, default env).

| Directory | Contents |
|---|---|
| [`commands/`](commands/README.md) | One folder per `belz rd` command |
| [`lib/`](lib/README.md) | Wire client, datasource resolution, definitions and specs |
| [`tests/`](tests/README.md) | Unit tests over a fake RD server |

Exports: `@belzabar/rd/registry` and `@belzabar/rd/lib/<file>`.

## Commands

| Command | Kind | What it does |
|---|---|---|
| `belz rd find [<query>]` | read | Reports whose title matches (`--sort`, `--limit`, `--archived`) |
| `belz rd show <id>` | read | Definition: datasource, columns, saved filters, summaries |
| `belz rd export <id> --out <file>` | read (local write) | The portable spec |
| `belz rd datasources [--category <name>]` | read | Datasource categories, or a category's published methods |
| `belz rd uses <method-uuid>` | read | Reports whose datasource is that AD method |
| `belz rd run <id> --env <env>` | **runs** | Rows of the report as saved (`--limit`, `--offset`, `--count`) |
| `belz rd download <id> --env <env>` | **runs** | CSV / xlsx / PDF export, polled until ready and saved |

**Runs** execute the datasource method on the server (and move the report's execution time
and version counter), so they declare `writes` and need an explicit `--env`; nothing in the
saved definition changes.

`--exact` on `show` / `export` also reads `summaryPosition` and `filterConfig`. The server
returns those two only from a call that **runs the report**, so `--exact` counts as a write
(`--env` required). Without it they are reported in `unread` and a saved spec uses the defaults
(summaries at top, `filterConfig` 0).

Flags and examples: each `commands/<cmd>/help.txt` or `belz --help-full rd`.

## The spec file

`rd export` writes it (`"format": "belz.rd.report/1"`):

```json
{
  "format": "belz.rd.report/1",
  "title": "Orders by day",
  "description": "Daily totals",
  "dataSource": { "category": "Reports", "method": "orders_by_day" },
  "columns": [ { "id": "111", "name": "Day", "label": "Day", "type": "DATE", "filterable": true, "reportable": true } ],
  "filters": [ { "columnId": "111", "operandId": 6, "value": "2026-01-01", "applied": true } ],
  "summaries": [],
  "isFilterRequired": false
}
```

Columns, filters and summaries are kept exactly as Report Designer stores them (a column's
`id` is a hash of its name, the same on every env).

## Error codes

| Code | When |
|---|---|
| `RD_INVALID_ID` / `MISSING_REPORT_ID` | The `<id>` is not 32 hex or a URL ending in one |
| `RD_NOT_FOUND` | No such report on this env |
| `RD_NO_DATASOURCE` | `run` / `download` on a report that has no datasource saved yet |
| `RD_EXPORT_TIMEOUT` / `RD_DOWNLOAD_FAILED` | The export did not finish within `--wait`, or the file could not be fetched |
| `RD_WRITE_FILE_FAILED` | The local file could not be written |
| `RD_BAD_RESPONSE` | The server answered with an unexpected shape |
| `RD_HTTP_<status>` | Any other server error (message = the server's `errorMessage`) |

## Testing

```bash
bun test integrations/report-designer
```

See [`tests/README.md`](tests/README.md).
