# AGENTS.md — Page Designer

## Purpose

This directory provides the PD command modules and lib for the Page Designer. It provides CLI analysis tools for Page Designer (PD) configuration:

1. Inspect page/component configs
2. Extract referenced AD method IDs
3. Recursively analyze page/component dependency trees
4. Compare discovered IDs with a local approved master list

This is a **source-only module** — no standalone binary or package.json. All commands are served via `belz pd <cmd>` (unified binary built in `cli/`).

## Tech

1. Runtime: Bun + TypeScript
2. Commands discovered by: `cli/utils/generate-registry.ts` from `../page-designer/commands/`
3. Shared runner/framework: `@belzabar/core`

## Command Routing

```
belz pd show-page <PAGE_ID>
belz pd show-component <NAME>
belz pd find-ad-methods <ID>
belz pd analyze [PAGE_ID]
belz pd inspect-url <PD_URL>
```

When adding or removing PD commands, run `bun run generate` from `cli/` — this updates `cli/commands/registry-pd.ts`.

## Directory Map

1. `commands/` - command modules (`index.ts`, `help.txt`)
2. `lib/` - API/parsing/analysis/report/comparator services
3. `components.json` - component whitelist used during recursive analysis
4. `master_ids.txt` - approved AD ID list for compliance checks

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
6. PD URL parsing: `lib/url-parser.ts`
7. Default target page IDs: inlined in `commands/analyze/index.ts`

## Known Current Gaps

1. Component fetch path relies on a `PUT` endpoint with a partial-update payload; treat changes here carefully.
2. Extraction regex assumes alphanumeric AD IDs in execute URLs.
3. `inspect-url` metadata fields (`draftId`, `publishedId`, `versionId`) are best-effort and may be `null` when backend responses omit them.

## Help Text Standard

All `help.txt` files follow the standard defined in `automation-designer/AGENTS.md`.
Use `belz pd` as the command prefix for all PD commands.

## Safe Change Checklist

1. If adding/removing commands, run `bun run generate` from `cli/` and commit `cli/commands/registry-pd.ts`.
2. Keep `components.json` and `master_ids.txt` semantics documented when formats change.
3. Keep command help text aligned with real flags and behavior.
4. When adding a command, include a `help.txt` following the standard in `automation-designer/AGENTS.md`.
5. Avoid parser regex changes without validating against real PD payload samples.

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this module — new or removed
commands, changed traversal or parsing logic, new lib files, changed output schema, or file
format changes — update this `AGENTS.md` in the same commit. Run `bun run generate` from `cli/`
and commit the updated `registry-pd.ts` alongside your changes.
