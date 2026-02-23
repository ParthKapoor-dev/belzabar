# AGENTS.md - Automation Designer CLI

## Purpose

This app provides CLI-first access to Automation Designer (AD) method workflows:

1. Inspect method definitions
2. Test draft methods
3. Execute published methods
4. Save and run local regression suites

Primary binary name: `belz`

## Tech and Entry Points

1. Runtime: Bun + TypeScript
2. Dev entrypoint: `bin/cli.ts`
3. Build entrypoint: `bin/cli-build.ts`
4. Command registry (generated): `commands/registry.ts`
5. Shared runner/framework: `@belzabar/core`

## Directory Map

1. `bin/` - CLI entrypoints
2. `commands/` - one folder per command (`index.ts`, `help.txt`, optional `README.md`)
3. `lib/` - app-level logic (api/hydration/parsing/input/payload/error parsing)
4. `integrations/gemini-mcp/` - MCP server shim that shells out to CLI
5. `tests/` - unit tests for parser/payload utilities

## Commands Implemented

1. `envs`
2. `fetch-method`
3. `show-method`
4. `test-method`
5. `run-method`
6. `save-suite`
7. `run-suites`
8. `sql`

## Core Behavior Contract

1. Use `CommandModule` from `@belzabar/core`.
2. `parseArgs` validates/parses input only.
3. `execute` contains business logic and returns `ok(...)`/`fail(...)` or throws `CliError`.
4. `presentHuman` is optional and only for human-friendly rendering.
5. Command modules must not call `process.exit` or print ad-hoc output for machine mode.

## Output Contract

1. Human mode: tables/sections/objects rendered by presenter or default renderer.
2. `--llm` mode: single JSON envelope:
   - `schema`
   - `version`
   - `ok`
   - `command`
   - `data`
   - `error`
   - `meta`
3. `--raw` is command-specific and must be explicit.

## Runtime Data and Caching

1. Auth sessions:
   - `~/.belzabar-cli/sessions/<env>.json`
2. Method cache:
   - `~/.belzabar-cli/cache/methods/<uuid>.json`
   - TTL currently 5 minutes
3. Service definition cache:
   - `~/.belzabar-cli/cache/definitions/<automationId>.json`
4. Local test suites:
   - `./suites/*.spec.json`

## Important Files for Agents

1. API wrappers: `lib/api.ts`
2. Method parser: `lib/parser.ts`
3. Show-method deep inspection: `commands/show-method/index.ts`
4. Test payload injection: `lib/payload-builder.ts`
5. Trace error interpretation: `lib/error-parser.ts`
6. MCP adapter: `integrations/gemini-mcp/server.ts`
7. SQL command entrypoint: `commands/sql/index.ts`
8. SQL helper modules: `lib/sql/`

## Known Current Gaps

1. `test-method` parses `--force` and `--verbose`, but execution currently does not use `force`, and `verbose` does not expand trace detail.
2. `show-method --service-detail` help text says 0-indexed, while lookup is by `orderIndex` value.
3. `save-suite` writes to `suites/` path and assumes directory availability.
4. `--llm` intent and current behavior are noted as mismatched in `tasks.md`.

## Safe Change Checklist

1. If adding/removing commands, regenerate and commit `commands/registry.ts`.
2. Keep `help.txt` and command docs aligned with actual flags.
3. Preserve envelope schema stability for `--llm` consumers and MCP tools.
4. Validate auth mode (`Bearer` vs `Raw`) for each endpoint before changing requests.

## Maintenance Note

If this app changes (commands, behavior, API flow, file layout, output schema), update this `AGENTS.md` in the same change.
