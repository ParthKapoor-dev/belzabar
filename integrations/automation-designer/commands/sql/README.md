# SQL Command

Executes read-mode SQL queries through Automation Designer's DB service operation.

## Usage

```bash
bun run bin/cli.ts sql run "select * from users limit 1"
bun run bin/cli.ts sql dbs
bun run bin/cli.ts sql tui
```

## Subcommands

- `run <query>`
  - Executes query using the DB read operation (`select`).
  - Optional `--db <nickname|id>` overrides DB selection.
  - DB selection priority:
    1. `--db`
    2. `BELZ_SQL_DEFAULT_DB`
    3. `NSM_Read_DB` fallback

- `dbs`
  - Lists available DB auth configurations from `/rest/api/automation-systems/db_service/auth`.

- `tui`
  - Starts an interactive SQL session with multiline query support and pagination.
  - Uses read-mode execution for each statement.
  - Supports psql-like meta commands (`\\q`, `\\db`, `\\use`, etc.).

## Flags

- `--raw`
  - `run`: include operation metadata, generated payload, and full execution response.
  - `dbs`: include raw list response.

- `tui` flags
  - `--db <nickname|id>`: starting database.
  - `--format <table|json>`: result output mode.
  - `--timing`: print timing after each statement.
  - `--page-size <n>`: page size for paginated results.
  - `--no-history`: disable persisted query history for current session.

## Notes

- `sql tui` is interactive and intended for human use.
- `sql tui --llm` is rejected intentionally.
- This command currently targets read-mode operation only.
- Future write/DDL modes should be added as additional SQL subcommands under `belz sql`.
