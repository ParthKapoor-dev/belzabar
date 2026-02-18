# AGENTS.md - Page Designer CLI

## Purpose

This app provides CLI analysis tools for Page Designer (PD) configuration:

1. Inspect page/component configs
2. Extract referenced AD method IDs
3. Recursively analyze page/component dependency trees
4. Compare discovered IDs with a local approved master list

Primary binary name: `pd`

## Tech and Entry Points

1. Runtime: Bun + TypeScript
2. Dev entrypoint: `bin/pd.ts`
3. Build entrypoint: `bin/pd-build.ts`
4. Command registry (generated): `commands/registry.ts`
5. Shared CLI framework: `@belzabar/core`

## Directory Map

1. `bin/` - CLI entrypoints
2. `commands/` - command modules (`index.ts`, `help.txt`)
3. `lib/` - API/parsing/analysis/report/comparator services
4. `utils/` - registry generation helper
5. `components.json` - component whitelist used during recursive analysis
6. `master_ids.txt` - approved AD ID list for compliance checks

## Commands Implemented

1. `show-page`
2. `show-component`
3. `find-ad-methods`
4. `analyze`

## Core Behavior Contract

1. Commands are `CommandModule` implementations from `@belzabar/core`.
2. `show-page` and `show-component` fetch and summarize config payloads.
3. `find-ad-methods` supports shallow or recursive extraction.
4. `analyze` runs recursive analysis from one root page or default roots and can run compliance checks.
5. `--llm` mode returns envelope JSON through the shared core runner.

## Parsing and Analysis Model

1. AD IDs are extracted from URL patterns matching `/rest/api/automation/chain/execute/<id>`.
2. Component dependencies are extracted from layout nodes and filtered through `components.json`.
3. Recursive traversal uses a visited-set to prevent cycles.
4. Final reporting includes:
   - formatted dependency trees
   - sorted unique AD IDs
   - optional compliance diff (`rogue`, `missing`, `common`)

## Important Files for Agents

1. API adapters: `lib/api.ts`
2. Reference extraction: `lib/parser.ts`
3. Recursive traversal: `lib/analyzer.ts`
4. Tree/id reporting: `lib/reporter.ts`
5. Compliance logic: `lib/comparator.ts`
6. Default target page list: `lib/config.ts`

## Known Current Gaps

1. `README.md` is outdated and still includes generic Bun-init instructions (`bun run index.ts`).
2. Component fetch path relies on a `PUT` endpoint with a partial-update payload; treat changes here carefully.
3. Extraction regex assumes alphanumeric AD IDs in execute URLs.

## Safe Change Checklist

1. If adding/removing commands, regenerate and commit `commands/registry.ts`.
2. Keep `components.json` and `master_ids.txt` semantics documented when formats change.
3. Keep command help text aligned with real flags and behavior.
4. Avoid parser regex changes without validating against real PD payload samples.

## Maintenance Note

If this app changes (commands, traversal logic, file formats, output schema, or API behavior), update this `AGENTS.md` in the same change.
