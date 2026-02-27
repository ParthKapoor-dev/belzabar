# AGENTS.md - Page Designer CLI

## Purpose

This app provides CLI analysis tools for Page Designer (PD) configuration:

1. Inspect page/component configs
2. Extract referenced AD method IDs
3. Recursively analyze page/component dependency trees
4. Compare discovered IDs with a local approved master list

Primary binary name: `pd` (standalone) — also accessible via `belz pd <cmd>` (unified binary).

## Tech and Entry Points

1. Runtime: Bun + TypeScript
2. Dev entrypoint: `bin/pd.ts`
3. Build entrypoint: `bin/pd-build.ts`
4. Command registry (generated): `commands/registry.ts`
5. Shared CLI framework: `@belzabar/core`

## Unified CLI Note

PD commands are also exposed through the unified `belz` binary built in `apps/automation-designer/`:

```
belz pd show-page <PAGE_ID>
belz pd show-component <NAME>
belz pd find-ad-methods <ID>
belz pd analyze [PAGE_ID]
belz pd inspect-url <PD_URL>
```

When adding or removing PD commands:
1. Regenerate `commands/registry.ts` in this app (`bun run generate` here).
2. **Also** regenerate the unified binary registries in `apps/automation-designer/` (`bun run generate` there) — this updates `commands/registry-pd.ts`.
3. Rebuild the `belz` binary (`bun run build` in `apps/automation-designer/`).

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
5. `inspect-url`

## Core Behavior Contract

1. Commands are `CommandModule` implementations from `@belzabar/core`.
2. `show-page` and `show-component` fetch and summarize config payloads.
3. `find-ad-methods` supports shallow or recursive extraction.
4. `analyze` runs recursive analysis from one root page or default roots and can run compliance checks.
5. `inspect-url` accepts a full PD URL (`/ui-designer/page/...` or `/ui-designer/symbol/...`) and returns quick metadata + children + AD refs, with optional recursive traversal.
6. `--llm` mode returns envelope JSON through the shared core runner.

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
7. PD URL parsing: `lib/url-parser.ts`

## Known Current Gaps

1. Component fetch path relies on a `PUT` endpoint with a partial-update payload; treat changes here carefully.
2. Extraction regex assumes alphanumeric AD IDs in execute URLs.
3. `inspect-url` metadata fields (`draftId`, `publishedId`, `versionId`) are best-effort and may be `null` when backend responses omit them.

## Help Text Standard

All `help.txt` files follow the standard defined in `apps/automation-designer/AGENTS.md`.
Use `belz pd` as the command prefix for all PD commands.

## Safe Change Checklist

1. If adding/removing commands, regenerate and commit `commands/registry.ts` (here) **and** `commands/registry-pd.ts` in `apps/automation-designer/`.
2. Keep `components.json` and `master_ids.txt` semantics documented when formats change.
3. Keep command help text aligned with real flags and behavior.
4. When adding a command, include a `help.txt` following the standard in `apps/automation-designer/AGENTS.md`.
5. Avoid parser regex changes without validating against real PD payload samples.

## Maintenance Note

If this app changes (commands, traversal logic, file formats, output schema, or API behavior), update this `AGENTS.md` in the same change.
