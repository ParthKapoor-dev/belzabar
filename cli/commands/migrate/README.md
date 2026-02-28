# Migrate Command

Runs NSM migrations via the DB migration tool execution protocol.

## Usage

```bash
bun run bin/cli.ts migrate profiles
bun run bin/cli.ts migrate run --module PD --ids <uuid1,uuid2> --profile devncdns_qancdns
```

## Subcommands

- `profiles`
  - Discovers available NSM profiles from the migration tool assets.
  - Uses local cache fallback under `~/.belzabar-cli/migrations/nsm-profiles.json`.

- `run`
  - Starts execution with `/executions/start`.
  - Connects to `/executions/io/<executionId>` websocket.
  - Automatically sends `yes` confirmation to begin migration.
  - Optionally calls `/executions/cleanup/<executionId>` after completion.

## Defaults

- `--crud Y`
- `--async Y`
- `--migrate-dependents N`
- `--cleanup auto`

## Output

- Human mode: migration summary table with report and artifact details.
- `--llm`: deterministic JSON envelope (`schema: ad.migrate`).
- `--raw`: includes low-level protocol payloads.

## Artifacts

Use `--out <path>` to persist local artifacts.

- `<base>.json`: summarized run data
- `<base>.stream.log`: parsed stream output
- `<base>.events.json`: raw stream events (only when `--raw`)
