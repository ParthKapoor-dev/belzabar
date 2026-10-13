# report-designer/tests/unit

| File | Covers |
|---|---|
| `fake-rd.ts` | The fake server: a temp env, an in-memory report store and the RD routes (it counts executing reads per report) |
| `definition.test.ts` | `parseReportId`, `parseSpec` (every problem listed), `toConfiguration`, `specChanges` |
| `read-commands.test.ts` | `find`, `show`, `export`, `datasources`, `uses`: no read runs a report except `--exact` |
| `write-commands.test.ts` | `create` (gate, dry run, PATCH/PUT with the env's ids, unresolved datasource), `save` (backup, kept display settings, no-op, `RD_CONFLICT`, `RD_VERIFY_FAILED`), `archive` |
| `run-commands.test.ts` | `run` (rows from the column-major result, the saved ids sent, `RD_NO_DATASOURCE`) and `download` (poll, presigned fetch without auth, XL format) |
