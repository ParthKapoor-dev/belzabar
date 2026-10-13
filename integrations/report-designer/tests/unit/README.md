# report-designer/tests/unit

| File | Covers |
|---|---|
| `fake-rd.ts` | The fake server: temp envs, an in-memory report store and the RD routes (it counts executing reads per report; the second env lists the same datasource under its own ids) |
| `definition.test.ts` | `parseReportId`, `parseSpec` (every problem listed), `toConfiguration`, `specChanges` |
| `read-commands.test.ts` | `find`, `show`, `export`, `datasources`, `uses`: no read runs a report except `--exact`; older reports without a category uuid are named from the AD chain |
| `write-commands.test.ts` | `create` (gate, dry run, PATCH/PUT with the env's ids, unresolved datasource), `save` (backup, kept display settings, no-op, `RD_CONFLICT`, `RD_VERIFY_FAILED`), `archive` |
| `copy.test.ts` | `copy` across two fake envs: target ids, `--exact`, `--into`, a datasource missing on the target, `RD_SAME_ENV` |
| `run-commands.test.ts` | `run` (rows from the column-major result, the saved ids sent, `RD_NO_DATASOURCE`, a report without a category uuid) and `download` (poll, presigned fetch without auth, XL format) |
