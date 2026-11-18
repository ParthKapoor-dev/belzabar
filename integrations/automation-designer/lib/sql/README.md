# lib/sql — `wi-impl ad sql`

Runs SQL through Automation Designer's `db_service`. There is no direct DB connection: each
statement is written into a copy of the `db_service` operation's own chain (the template),
which is posted as an inline test (`POST /rest/api/automation/chain/test`).

| Path | Contents |
|---|---|
| `api.ts` | `envUnavailableError` (a 502/503/504 gateway answer is `ENV_UNAVAILABLE`) and the `db_service` lookups: the DB auth list, the read / update / insert / modify operation contracts, and `fetchExecutableCategory` (a PUBLIC chain category to stamp on the posted chain; a lookup that finds none is retried once, and only a found one is cached per process). |
| `executor.ts` | `sqlDefaultDb`, `resolveSqlDbContext`, `load*Context` (operation + template chain) and `executeSqlReadQuery` / `executeSqlUpdate` / `executeSqlInsert` / `executeSqlModify`. |
| `payload.ts` | `buildSqlReadPayload`: the template chain with the DB account and query written into its SQL slot. |
| `read-only.ts` | The client-side gates: read (`checkReadOnlySql`, `assertReadOnlySql`, `splitExplain`, `buildExplainSql`), write (`checkWriteSql`, `assertWriteSql`) and bind parameters (`findParameterMarker`, `assertNoParameterMarkers`). |
| `selector.ts` | `normalizeSqlDatabases`, `resolveSqlDatabase` (by id or nickname, then the default). |
| `result.ts` | Parsers for the test response of each mode (rows, rows affected, generated keys), and `describeSqlFailure` / `sqlDatabaseMessage` for a failed statement. |
| `types.ts` | The wire and result types above. |
| `tui/` | The interactive session (`sql tui`). See [`tui/README.md`](tui/README.md). |

## Contracts

- **DB selection** when `--db` is absent: `environments.<env>.sqlDefaultDb` in
  `~/.wi-impl/config.json`, then `WI_IMPL_SQL_DEFAULT_DB`. There is no built-in name; without
  either, `SQL_DEFAULT_DB_NOT_FOUND`. `selectedBy` reports which one was used.
- **Read gate.** The read operation autocommits, so a write sent through `run` really commits.
  `run` and `explain` therefore accept exactly one read statement (after stripping comments
  and literals) and refuse the rest with `SQL_NOT_READ_ONLY`. Any `#{` is refused outright:
  the server evaluates SpEL, even inside literals, and splices the result into the SQL.
  `EXPLAIN` is judged by its inner statement, so `EXPLAIN ANALYZE DELETE …` is refused; plain
  `EXPLAIN` (no ANALYZE) only plans, so it also takes INSERT / UPDATE / DELETE / MERGE.
- **Write gate.** `update` takes UPDATE / DELETE (also after WITH), `insert` INSERT, `modify`
  DDL. An empty or comment-only statement (the server runs it and reports success) is
  `SQL_EMPTY_STATEMENT`; another kind is `SQL_WRONG_STATEMENT`. Checked at parse time and again
  in the executors (the TUI calls them directly).
- **Bind-parameter gate.** The server runs run / explain / update / insert statements through
  Spring's named-parameter template with no parameters, so a lone `?` or a `:name` (the `:6`
  of `arr[1:6]`) fails there. `findParameterMarker` mimics that parser and
  `assertNoParameterMarkers` refuses them first (`SQL_PARAMETER_MARKER`); `??` (reaches the DB
  as `?`), `arr[1: 6]` and `arr[1\:6]` pass (proven live).
- **Failures.** A statement the database refuses (`SQL_QUERY_FAILED`, `SQL_UPDATE_QUERY_FAILED`,
  …) has the database's own message in `error.message` (exception class names, Spring's
  `SQL [<query>]:` wrapper and `ERROR:` removed). The raw response repeats that message, with
  the query inside, 4–5 times; the envelope carries the query once (`details.query`; other
  copies become `<query>`) and `details.executionStatus` without the message copies.
- `insert … RETURNING <col>` returns the generated values.
- Without a PUBLIC chain category on the env the posted chain cannot run:
  `SQL_NO_EXECUTABLE_CATEGORY`. The lookup has failed once on an env where it worked seconds
  later, so it is retried once (after 1.5 s) and the error names the failed lookup
  (`details.lookupFailure`) and says to run the statement again.
- **Stopped env.** A stopped env answers every request with an HTML 503 page, and the first
  request is the database list, so it read as `SQL_DATABASES_FETCH_FAILED`. A 502 / 503 / 504
  from the `db_service` lookups or the statement POST is `ENV_UNAVAILABLE`, naming the env.
- `update`, `insert`, `modify` and `tui` are writes: explicit `--env`, confirmation or `--yes`.

New SQL modes are added as subcommands of `wi-impl ad sql` (`defineSubcommands` in
`commands/sql/index.ts`).

Tests: `sql-*.test.ts` in [`../../tests/unit`](../../tests/unit/README.md).

Up: [`../README.md`](../README.md)
