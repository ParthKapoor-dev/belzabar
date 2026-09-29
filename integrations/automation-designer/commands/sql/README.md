# ad sql

Runs SQL through Automation Designer's `db_service` operations. `dbs`, `run` and
`explain` are reads. `update`, `insert`, `modify` and `tui` are writes: they need an
explicit `--env`, and a confirmation or `--yes`.

## Usage

```bash
belz ad sql dbs
belz ad sql run "select * from users limit 1"
belz ad sql explain "select * from users where id = 1" --analyze
belz ad sql update "UPDATE t SET x = 1 WHERE id = 2" --db <db> --env <env> --yes
belz ad sql tui --env <env>
```

## Subcommands

- `run <query>`
  - Executes ONE read statement (SELECT / WITH … SELECT / VALUES / EXPLAIN of a read)
    through the DB read operation. Anything else is refused client-side
    (`SQL_NOT_READ_ONLY`, `lib/sql/read-only.ts`).
  - Optional `--db <nickname|id>` overrides DB selection.
  - DB selection priority:
    1. `--db`
    2. `environments.<env>.sqlDefaultDb` in `~/.belz/config.json` (per env)
    3. `BELZ_SQL_DEFAULT_DB`
    (no built-in database name: without these, pass `--db`)

- `explain <query>` (7.11)
  - Plan of one read statement: `EXPLAIN [(ANALYZE, BUFFERS, FORMAT JSON)] <query>`.
  - The inner statement passes the same read-only gate as `run` (`lib/sql/read-only.ts:splitExplain`):
    ANALYZE executes it, so DML is refused even inside `EXPLAIN ANALYZE`.
  - `--analyze`, `--buffers` (needs --analyze), `--format text|json`; `timing` from the plan.

- `dbs`
  - Lists available DB auth configurations from `/rest/api/automation-systems/db_service/auth`.

- `update <query>` / `insert <query>` / `modify <query>`
  - UPDATE/DELETE, INSERT (`RETURNING <col>` returns the generated values), and DDL.

- `tui`
  - Starts an interactive SQL session with multiline query support and pagination.
  - Prompts for the DB and the mode (read|insert|update|modify) unless `--db` / `--mode` are given; `\mode` switches mode in the session.
  - Supports psql-like meta commands (`\q`, `\db`, `\use`, etc.).

## Flags

- `--raw`
  - `run`: include operation metadata, generated payload, and full execution response.
  - `dbs`: include raw list response.

- `tui` flags
  - `--db <nickname|id>`: starting database.
  - `--mode <read|insert|update|modify>`: starting mode.
  - `--format <table|json>`: result output mode.
  - `--timing`: print timing after each statement.
  - `--page-size <n>`: page size for paginated results.
  - `--no-history`: disable persisted query history for current session.

## Notes

- `sql tui` is interactive and intended for human use. `sql tui --llm` is rejected
  intentionally.
- New SQL modes are added as subcommands of `belz ad sql` (`defineSubcommands` in
  `index.ts`).
