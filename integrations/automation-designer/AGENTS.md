# AGENTS.md — Automation Designer

## Purpose

This directory contains the **AD command modules and lib** for the Automation Designer. It provides:

1. Namespaced `belz ad` commands for Automation Designer method workflows
2. Shared lib for API calls, parsing, hydration, payload building, caching

The unified `belz` binary is built from `cli/` (repo root). This directory is a source module — it has no binary or standalone entry point.

## Command Routing

```
belz ad <cmd>   → find, fetch, show, show-code, outputs, state, categories,
                  services, export, export-category, test-cases, test-report,
                  child-info, test, run, save-suite, run-suites, sql,
                  save, publish, import, category, test-case
```

All commands accept `--v2` (universal flag, handled by
`lib/args/common.ts:parseAdCommonArgs`). When the selected operation does not
implement V2, the command prints a one-line fallback warning and runs V1.
The per-operation version defaults live in `lib/api-version.ts:DEFAULT_VERSION`
— to flip a default, edit one cell. See `docs/api-notes.md` for the long-form
rationale.

## Tech

1. Runtime: Bun + TypeScript
2. Commands discovered by: `cli/utils/generate-registry.ts` from `../automation-designer/commands/`
3. Shared runner/framework: `@belzabar/core`

## Directory Map

1. `commands/` — one folder per AD command (`index.ts`, `help.txt`, `desc.txt`)
2. `lib/api-version.ts` — version enum, defaults, resolver
3. `lib/args/common.ts` — shared `--v2` flag parser + fallback warning
4. `lib/args/confirm.ts` — interactive confirmation helper for write commands
5. `lib/types/common.ts` — unified in-memory types (`HydratedMethod`,
   `ParsedStep`, `MethodField`, …). **Commands import only from this file.**
6. `lib/types/v1-wire.ts`, `lib/types/v2-wire.ts` — raw wire types, parser/
   serializer/api-client only
7. `lib/parser/{index,v1,v2}.ts` + `lib/parser/steps/{shared,v1,v2}.ts` —
   discriminated step parsing (custom code, SpEL, SQL, Redis, existing)
8. `lib/api/{index,v1,v2}.ts` — unified `adApi` façade; V1 full, V2 fetch+test
9. `lib/serialize/v1.ts` — HydratedMethod → V1 save payload (enforces the
   custom-code multi-output invariant)
10. `lib/draft-guard.ts` — `resolveDraftTarget` — the **only** way to locate a
    safe save target
11. `lib/base64.ts`, `lib/xml.ts` — helpers used by the parsers and V2 test
12. `lib/hydrator.ts`, `lib/cache.ts`, `lib/method-finder.ts`,
    `lib/payload-builder.ts`, `lib/input-collector.ts`, `lib/error-parser.ts`
13. `lib/sql/*` — SQL TUI (unchanged surface; internals migrated)
14. `integrations/gemini-mcp/` — MCP server shim that shells out to CLI
15. `tests/unit/` — parser, serializer, version resolver, draft guard, xml,
    base64, error detection, sql tests
16. `tests/fixtures/v1/`, `tests/fixtures/v2/` — step + method fixtures
17. `docs/api-notes.md` — belz-owned cheatsheet (read this before touching
    lib/api/*, lib/parser/*, or lib/draft-guard.ts)

### Adding new commands

After creating a `commands/<name>/index.ts` with `help.txt` and `desc.txt`,
regenerate the registries from the repo root:

```
cd cli && bun run generate
```

## Commands

### Read (`belz ad <cmd>`)

1. `fetch` — raw V1 or V2 fetch + cache
2. `find` — search and pick methods (cached index)
3. `show` — rich display with `[CODE]` / `[SPEL]` / `[SQL]` / `[REDIS-*]`
   badges, `--code`, `--sql`, `--outputs`, `--variables`, `--step <N>` flags
4. `show-code` — dump decoded custom-code source for all / a single step
5. `outputs` — inputs/variables/outputs contract only (agent-friendly)
6. `state` — draft/published linkage, version, staleness (wraps draft-guard)
7. `categories` — list AD categories; filter by `--user` / `--system`
8. `services` — list platform services (`--internal`, `--search <q>`)
9. `export` — export a single method as JSON
10. `export-category` — export every method in a category
11. `test-cases` — list persistent test cases on a method
12. `test-report` — latest test-suite execution report
13. `child-info` — resolve a child method's inputs/outputs by name
14. `test` — V1 test-before-save with rich per-step trace
15. `run` — live-execute a published method
16. `save-suite`, `run-suites` — local `.spec.json` suites (V1)
17. `sql` — interactive SQL TUI against the AD SQL service

### Write (`belz ad <cmd>`) — all draft-guarded

1. `save <file> --uuid <draftUuid>` — save a JSON overlay onto a draft
2. `publish <uuid>` — promote a draft to its published version
3. `import <file>` — POST `/chain/import`
4. `category create <name>` — create a new AD category/service
5. `test-case <action>` — `list | create | update | delete | bulk |
   run-suite | delete-suite` (V1 supports test-case UPDATE)

**Every write command MUST route through `lib/draft-guard.ts:resolveDraftTarget`
before saving.** Never POST a save payload whose UUID resolves to PUBLISHED —
the server will silently overwrite production. Interactive confirm is required
unless `--yes` is passed; in `--llm` mode, `--yes` is mandatory.

## Core Behavior Contract

1. Use `CommandModule` from `@belzabar/core`.
2. `parseArgs` validates/parses input only.
3. `execute` contains business logic and returns `ok(...)`/`fail(...)` or throws `CliError`.
4. `presentHuman` is optional and only for human-friendly rendering.
5. Command modules must not call `process.exit` or print ad-hoc output for machine mode.
6. `find` supports `list` (category counts), query search, and `pick` (interactive `fzf` method picker in human mode only), plus `--open` to open the selected method URL after pick.

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
3. Method finder index cache: `~/.belz/cache/method-finder/index-v1-<env>.json` (TTL 7 days)
4. Service definition cache: `~/.belz/cache/definitions/<automationId>.json`
5. Migration profile cache: `~/.belz/migrations/nsm-profiles.json`
6. Local test suites: `./suites/*.spec.json`

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

Run `bun run generate` from `cli/` to regenerate all registries (not from this directory):

- `cli/commands/registry-ad.ts` — exports `ADCommandRegistry` (imports from `../../automation-designer/commands/`)
- `cli/commands/registry-pd.ts` — exports `PDCommandRegistry` (imports from `../../page-designer/commands/`)
- `cli/commands/registry-top.ts` — exports `TopLevelCommandRegistry` (envs + migrate)
- `cli/commands/registry-help.ts` — embedded help text maps for compiled binary

## Important Files for Agents

1. API wrappers: `lib/api.ts`
2. Method finder index/search logic: `lib/method-finder.ts`
3. Method parser: `lib/parser.ts`
4. Find command entrypoint: `commands/find/index.ts`
5. Show command deep inspection: `commands/show/index.ts`
6. Test payload injection: `lib/payload-builder.ts`
7. Trace error interpretation: `lib/error-parser.ts`
8. MCP adapter: `integrations/gemini-mcp/server.ts`
9. SQL command entrypoint: `commands/sql/index.ts`
10. SQL helper modules: `lib/sql/`
11. SQL TUI session: `lib/sql/tui/session.ts`
12. Migration command entrypoint: `cli/commands/migrate/index.ts`
13. Migration helper modules: `migrations/lib/`

## Known Current Gaps

1. `test` parses `--force` and `--verbose`, but execution currently does not use `force`, and `verbose` does not expand trace detail.
2. `show --service-detail` help text says 0-indexed, while lookup is by `orderIndex` value.
3. `save-suite` writes to `suites/` path and assumes directory availability.

## desc.txt Standard

Every command must have a `desc.txt` alongside its `help.txt`.
Format: one line per invocation variant, covering the base call and every meaningful flag/subcommand:

```
belz ad <cmd> <args>  :->  What the base call does
belz ad <cmd> <args> --flag  :->  What this flag adds
belz ad <cmd> <args> --flag <value>  :->  What this flag+value does
```

This file feeds `belz --help-full` — the canonical per-command reference for agents and LLMs.
Update it whenever you add, remove, or change any flag or subcommand.

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

1. If adding/removing AD commands, run `bun run generate` from `cli/` and commit all registry files.
2. Keep `help.txt` and command docs aligned with actual flags.
3. When adding a command, include both a `help.txt` and a `desc.txt` following the standards above.
4. When changing flags or subcommands, update `desc.txt` to match — this keeps `belz --help-full` accurate.
5. Preserve envelope schema stability for `--llm` consumers and MCP tools.
6. Validate auth mode (`Bearer` vs `Raw`) for each endpoint before changing requests.

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this module — new or removed
commands, changed API behavior, new lib files, output schema changes, or structural
reorganization — update this `AGENTS.md` in the same commit. Run `bun run generate` from `cli/`
and commit all updated registry files alongside your changes.
