# AGENTS.md - Automation Designer CLI (Unified belz binary)

## Purpose

This app builds and owns the unified `belz` binary. It provides:

1. Namespaced `belz ad` commands for Automation Designer method workflows
2. Namespaced `belz pd` commands for Page Designer analysis (PD source stays in `apps/page-designer/`)
3. Top-level `belz migrate` and `belz envs` commands that span AD + PD

Primary binary name: `belz`

## Command Routing

```
belz ad <cmd>      → get, show, test, run, save-suite, run-suites, sql
belz pd <cmd>      → show-page, show-component, find-ad-methods, analyze, inspect-url
belz migrate ...   → top-level (spans AD + PD modules)
belz envs          → top-level (environment listing)
```

## Tech and Entry Points

1. Runtime: Bun + TypeScript
2. Dev entrypoint: `bin/cli.ts` — dynamically loads both AD and PD commands
3. Build entrypoint: `bin/cli-build.ts` — uses generated registries (bundled at compile time)
4. Generated registries: `commands/registry-ad.ts`, `commands/registry-pd.ts`, `commands/registry-top.ts`
5. Legacy registry: `commands/registry.ts` (backward-compat, all AD commands)
6. Shared runner/framework: `@belzabar/core`

## Directory Map

1. `bin/` - CLI entrypoints
2. `commands/` - one folder per AD command (`index.ts`, `help.txt`, optional `README.md`)
3. `lib/` - app-level logic (api/hydration/parsing/input/payload/error parsing)
4. `integrations/gemini-mcp/` - MCP server shim that shells out to CLI
5. `tests/` - unit tests for parser/payload utilities
6. `utils/generate-registry.ts` - generates the three split registries + legacy

## Commands

### AD Commands (`belz ad <cmd>`)

1. `get`
2. `show`
3. `test`
4. `run`
5. `save-suite`
6. `run-suites`
7. `sql`

### PD Commands (`belz pd <cmd>`)

1. `show-page`
2. `show-component`
3. `find-ad-methods`
4. `analyze`
5. `inspect-url`

### Top-level Commands (`belz <cmd>`)

1. `envs`
2. `migrate`

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

All runtime state lives under `~/.belz/`:

1. Auth sessions: `~/.belz/sessions/<env>.json`
2. Method cache: `~/.belz/cache/methods/<uuid>.json` (TTL 5 minutes)
3. Service definition cache: `~/.belz/cache/definitions/<automationId>.json`
4. Migration profile cache: `~/.belz/migrations/nsm-profiles.json`
5. Local test suites: `./suites/*.spec.json`

## `~/.belz/config.json`

Optional credential config file. Loaded at startup; **config file wins** over env vars.

```json
{
  "environments": {
    "nsm-dev":  { "url": "...", "user": "...", "password": "<base64>" },
    "nsm-qa":   { "url": "...", "user": "...", "password": "<base64>" },
    "nsm-uat":  { "url": "...", "user": "...", "password": "<base64>" }
  }
}
```

All fields per-env are optional — missing ones fall back to env vars (`NSM_DEV_USER`, etc.).
`password` is base64-encoded (decoded via `atob()` in `Config.password`).

## Registry Generation

Run `bun run generate` in `apps/automation-designer/` to regenerate all registries:

- `commands/registry-ad.ts` — exports `ADCommandRegistry` (AD-only, excludes migrate + envs)
- `commands/registry-pd.ts` — exports `PDCommandRegistry` (imports from `../../page-designer/commands/`)
- `commands/registry-top.ts` — exports `TopLevelCommandRegistry` (migrate + envs)
- `commands/registry.ts` — exports legacy `CommandRegistry` (all AD commands, backward-compat)

## Important Files for Agents

1. API wrappers: `lib/api.ts`
2. Method parser: `lib/parser.ts`
3. Show command deep inspection: `commands/show/index.ts`
4. Test payload injection: `lib/payload-builder.ts`
5. Trace error interpretation: `lib/error-parser.ts`
6. MCP adapter: `integrations/gemini-mcp/server.ts`
7. SQL command entrypoint: `commands/sql/index.ts`
8. SQL helper modules: `lib/sql/`
9. SQL TUI session: `lib/sql/tui/session.ts`
10. Migration command entrypoint: `commands/migrate/index.ts`
11. Migration helper modules: `lib/migration/`

## Known Current Gaps

1. `test` parses `--force` and `--verbose`, but execution currently does not use `force`, and `verbose` does not expand trace detail.
2. `show --service-detail` help text says 0-indexed, while lookup is by `orderIndex` value.
3. `save-suite` writes to `suites/` path and assumes directory availability.

## Help Text Standard

Every command must have a `help.txt` following this exact template:

```
Usage: belz <ns> <cmd> <REQUIRED_ARG> [OPTIONAL_ARG] [flags]

One-sentence description of what the command does.

Arguments:
  <REQUIRED_ARG>        Description.
  [OPTIONAL_ARG]        Description. Defaults to X if omitted.

Flags:
  --flag-name <VALUE>   Description. (default: X)
  --bool-flag           Description.
  --help, -h            Show this help message.

Global Flags:
  --env <name>          Set active environment. (default: nsm-dev)
                        Available: nsm-dev | nsm-qa | nsm-uat
  --llm                 Output structured JSON envelope for scripting/LLM use.

Examples:
  belz <ns> <cmd> <example1>
  belz <ns> <cmd> <example2> --flag
  belz <ns> <cmd> <example3> --flag --llm
```

Rules:
1. Prefix: `belz ad` for AD commands · `belz pd` for PD commands · `belz` for top-level
2. Required positionals: UPPERCASE in `<>` — `<UUID>`, `<FILE>`, `<NAME>`
3. Optional positionals: in `[]` — `[PAYLOAD]`, `[PAGE_ID]`
4. Column alignment: flag descriptions start at column 24
5. Required flags: end description with `(required)`
6. Defaults: end description with `(default: X)`
7. `--help, -h` is always the last Flags entry, before Global Flags
8. Always include the **Global Flags** section
9. Always use plural **Examples:** with 2–3 real examples
10. Blank line between every section

## Safe Change Checklist

1. If adding/removing AD commands, regenerate and commit all four registry files (`bun run generate`).
2. If adding PD commands, regenerate from `apps/automation-designer/` as well (PD registry lives here).
3. Keep `help.txt` and command docs aligned with actual flags.
4. When adding a command, include a `help.txt` following the standard in this file.
5. Preserve envelope schema stability for `--llm` consumers and MCP tools.
6. Validate auth mode (`Bearer` vs `Raw`) for each endpoint before changing requests.

## Maintenance Note

If this app changes (commands, behavior, API flow, file layout, output schema), update this `AGENTS.md` in the same change.
