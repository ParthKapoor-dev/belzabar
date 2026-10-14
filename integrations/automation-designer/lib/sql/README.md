# lib/sql — `wi-impl ad sql`

Runs SQL through Automation Designer's `db_service`. There is no direct DB connection: each
statement is written into a copy of the `db_service` operation's own chain (the template),
which is posted as an inline test (`POST /rest/api/automation/chain/test`).

| Path | Contents |
|---|---|
| `api.ts` | `db_service` lookups: the DB auth list, the read / update / insert / modify operation contracts, and `fetchExecutableCategory` (a PUBLIC chain category to stamp on the posted chain; cached per process). |
| `executor.ts` | `sqlDefaultDb`, `resolveSqlDbContext`, `load*Context` (operation + template chain) and `executeSqlReadQuery` / `executeSqlUpdate` / `executeSqlInsert` / `executeSqlModify`. |
| `payload.ts` | `buildSqlReadPayload`: the template chain with the DB account and query written into its SQL slot. |
| `read-only.ts` | The client-side read gate (`checkReadOnlySql`, `assertReadOnlySql`, `splitExplain`, `buildExplainSql`). |
| `selector.ts` | `normalizeSqlDatabases`, `resolveSqlDatabase` (by id or nickname, then the default). |
| `result.ts` | Parsers for the test response of each mode (rows, rows affected, generated keys, errors). |
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
  `EXPLAIN` is judged by its inner statement, so `EXPLAIN ANALYZE DELETE …` is refused.
- `insert … RETURNING <col>` returns the generated values.
- Without a PUBLIC chain category on the env the posted chain cannot run:
  `SQL_NO_EXECUTABLE_CATEGORY`.
- `update`, `insert`, `modify` and `tui` are writes: explicit `--env`, confirmation or `--yes`.

New SQL modes are added as subcommands of `wi-impl ad sql` (`defineSubcommands` in
`commands/sql/index.ts`).

Tests: `sql-*.test.ts` in [`../../tests/unit`](../../tests/unit/README.md).

Up: [`../README.md`](../README.md)
