# report-designer/commands

One folder per `wi-impl rd` command, each with `index.ts` (default `CommandModule` plus the
exported `args` spec), `help.txt` (the command's documentation) and `desc.txt` (its
`wi-impl --help-full` lines). Every folder is listed in [`../registry.ts`](../registry.ts).

| Folder | Command | Lib it uses |
|---|---|---|
| `archive/` | `wi-impl rd archive` | `getReportBasic`, `patchReport` (`?execute=true`), status read back |
| `copy/` | `wi-impl rd copy` | `readReport` on `--from-env` (`Config.withEnv`), `resolveDataSource` on `--env`, `createReport` or `planSave` / `applySave` |
| `create/` | `wi-impl rd create` | `readSpecFile`, `resolveDataSource`, `createReport` |
| `datasources/` | `wi-impl rd datasources` | `categories`, `findCategory`, `dataSourcesOf` |
| `download/` | `wi-impl rd download` | `readReport`, `requestExport`, `pollExport`; the presigned file is fetched without platform auth |
| `export/` | `wi-impl rd export` | `readReport`; writes the spec with `--out` (`writesLocal`) |
| `find/` | `wi-impl rd find` | `listReports` |
| `run/` | `wi-impl rd run` | `readReport`, `savedConfiguration`, `runReport`, `countRows` |
| `save/` | `wi-impl rd save` | `readSpecFile`, `resolveDataSource`, `planSave`, `applySave` |
| `show/` | `wi-impl rd show` | `readReport`, `view.ts` |
| `uses/` | `wi-impl rd uses` | `dependentReports` |

The `<id>` positional is `REPORT_ID_POSITIONAL` + `parseReportId`. A command that runs a report
on the server (`run`, `download`, `--exact`) declares it through `writes`, so the runner requires `--env`.

Write commands take `--yes` and go through `requireConfirmation`; `create` and `save` also
take `--dry-run` (`requiresEnv`: the preview reads the target env). `copy` writes only to
`--env` and reads `--from-env` in-process.

Commands return `ok(...)` or throw `CliError`; they never print or exit. Adding a command: see
[`../AGENTS.md`](../AGENTS.md).
