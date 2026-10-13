# @belzabar/rd

`belz rd …` — Report Designer: find and read reports without running them, run or download
them, export a report as a portable spec and create or save reports from one, archive them,
list datasources, and find the reports an AD method feeds.

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
| `belz rd create --spec <file> --env <env>` | **write** | New report from a spec (`--dry-run` resolves only) |
| `belz rd save <id> --spec <file> --env <env>` | **write** | Replace a report's definition (`--dry-run` lists the changes) |
| `belz rd archive <id> --env <env>` | **write** | Archive (`--restore`: unarchive) |

**Runs** execute the datasource method on the server (and move the report's execution time
and version counter), so they declare `writes` and need an explicit `--env`; nothing in the
saved definition changes.

`--exact` on `show` / `export` also reads `summaryPosition` and `filterConfig`. The server
returns those two only from a call that **runs the report**, so `--exact` counts as a write
(`--env` required). Without it they are reported in `unread` and a saved spec uses the defaults
(summaries at top, `filterConfig` 0).

Flags and examples: each `commands/<cmd>/help.txt` or `belz --help-full rd`.

## Write safety

Writes need `--env` and a confirmation (`--yes` in `--llm` mode; `RD_CONFIRMATION_REQUIRED`,
`RD_USER_ABORT`), and log a `[belz rd write]` line on stderr. Because Report Designer keeps no
history and the last write wins, `rd save`:

1. resolves the spec's datasource on the target env;
2. writes the current definition to `~/.belz/rd/backups/<env>/<id>-<time>.json` (a spec: save
   it back to undo);
3. refuses with `RD_CONFLICT` if the definition changed since it was read;
4. PATCHes the title / description when they change, PUTs the configuration, reads it back
   and compares (`RD_VERIFY_FAILED`, with the differences in `data.mismatches`).

`rd create` POSTs an empty report and then runs the same PATCH / PUT / read-back; if a step
after the POST fails, the error names the new id (`details.createdId`). There is no delete
command.

## The spec file

`rd export` writes it, `rd create` and `rd save` take it (`"format": "belz.rd.report/1"`):

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
`id` is a hash of its name, the same on every env). `parseSpec` lists every problem at once
(`RD_SPEC_INVALID`).

## Error codes

| Code | When |
|---|---|
| `RD_INVALID_ID` / `MISSING_REPORT_ID` | The `<id>` is not 32 hex or a URL ending in one |
| `RD_NOT_FOUND` | No such report on this env |
| `RD_DATASOURCE_CATEGORY_NOT_FOUND` / `RD_DATASOURCE_NOT_FOUND` / `RD_DATASOURCE_AMBIGUOUS` | The spec's datasource does not resolve on the target env (the method must be published there) |
| `RD_SPEC_UNREADABLE` / `RD_SPEC_INVALID` / `MISSING_SPEC` | The spec file is missing or malformed (`details.problems`) |
| `RD_CONFLICT` | `save`: the report changed on the server after belz read it; nothing written |
| `RD_VERIFY_FAILED` | The definition or status read back differs from what was written |
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
