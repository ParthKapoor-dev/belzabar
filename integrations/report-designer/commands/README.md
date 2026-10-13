# report-designer/commands

One folder per `belz rd` command, each with `index.ts` (default `CommandModule` plus the
exported `args` spec), `help.txt` (the command's documentation) and `desc.txt` (its
`belz --help-full` lines). Every folder is listed in [`../registry.ts`](../registry.ts).

| Folder | Command | Lib it uses |
|---|---|---|
| `archive/` | `belz rd archive` | `getReportBasic`, `patchReport` (`?execute=true`), status read back |
| `copy/` | `belz rd copy` | `readReport` on `--from-env` (`Config.withEnv`), `resolveDataSource` on `--env`, `createReport` or `planSave` / `applySave` |
| `create/` | `belz rd create` | `readSpecFile`, `resolveDataSource`, `createReport` |
| `datasources/` | `belz rd datasources` | `categories`, `findCategory`, `dataSourcesOf` |
| `download/` | `belz rd download` | `readReport`, `requestExport`, `pollExport`; the presigned file is fetched without platform auth |
| `export/` | `belz rd export` | `readReport`; writes the spec with `--out` (`writesLocal`) |
| `find/` | `belz rd find` | `listReports` |
| `run/` | `belz rd run` | `readReport`, `savedConfiguration`, `runReport`, `countRows` |
| `save/` | `belz rd save` | `readSpecFile`, `resolveDataSource`, `planSave`, `applySave` |
| `show/` | `belz rd show` | `readReport`, `view.ts` |
| `uses/` | `belz rd uses` | `dependentReports` |

The `<id>` positional is `REPORT_ID_POSITIONAL` + `parseReportId`. A command that runs a report
on the server (`run`, `download`, `--exact`) declares it through `writes`, so the runner requires `--env`.

Write commands take `--yes` and go through `requireConfirmation`; `create` and `save` also
take `--dry-run` (`requiresEnv`: the preview reads the target env). `copy` writes only to
`--env` and reads `--from-env` in-process.

Commands return `ok(...)` or throw `CliError`; they never print or exit. Adding a command: see
[`../AGENTS.md`](../AGENTS.md).
