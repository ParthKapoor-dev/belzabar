# lib/sql/tui — the interactive SQL session

`belz ad sql tui`: a psql-like REPL over the executors in [`../executor.ts`](../executor.ts).
Human use only (`--llm` fails `SQL_TUI_UNSUPPORTED_IN_LLM`). It can switch into write modes,
so the command is a write and needs an explicit `--env`.

| File | Contents |
|---|---|
| `session.ts` | `runSqlTuiSession`: DB and mode prompts (skipped by `--db` / `--mode`), multiline input, dispatch to the read / insert / update / modify executor. |
| `commands.ts` | Meta commands (`\q`, `\h`, `\status`, `\db`, `\use`, `\mode`, `\history`, `\clear`, `\timing`, `\format`, `\last`, `\r`) and their parser. |
| `renderer.ts` | `renderRowsWithPagination`: table or JSON output, `--page-size` rows per page. |
| `history.ts` | Query history in `~/.wi-impl/sql_history` (last 2000 entries; `--no-history` turns it off). |
| `types.ts` | `SqlTuiArgs`, `SqlTuiMode`, `SqlTuiFormat`, session state. |

The read mode goes through the same read-only gate as `sql run`
([`../read-only.ts`](../read-only.ts)).

Tests: `sql-tui-commands.test.ts` in [`../../../tests/unit`](../../../tests/unit/README.md).

Up: [`../README.md`](../README.md)
