# AGENTS.md — Page Designer

## Purpose

This directory provides the PD command modules and lib for the Page Designer. It provides CLI tools for deep inspection of PD configurations:

1. Inspect page/component configs — variables, HTTP calls, component trees, bindings
2. Validate configs against 10 known error patterns from the PD spec
3. Extract referenced AD method IDs
4. Search pages and components from a cached index
5. Recursively analyze page/component dependency trees with compliance checks

This is a **source-only module** — no standalone binary or package.json. All commands are served via `belz pd <cmd>` (unified binary built in `cli/`).

## Tech

1. Runtime: Bun + TypeScript
2. Commands discovered by: `cli/utils/generate-registry.ts` from `../page-designer/commands/`
3. Shared runner/framework: `@belzabar/core`

## Command Routing

```
belz pd show <INPUT>             # unified page/component inspection
belz pd validate <INPUT>         # config validation (10 checks)
belz pd find [query]             # search pages/components
belz pd find-ad-methods <ID>     # extract AD method IDs
belz pd analyze [PAGE_ID]        # recursive dependency + compliance
```

When adding or removing PD commands, run `bun run generate` from `cli/` — this updates `cli/commands/registry-pd.ts`.

## Directory Map

1. `commands/` - command modules (`index.ts`, `help.txt`)
2. `lib/` - API, parsing, analysis, resolver, cache, reporting services
3. `components.json` - component whitelist used during recursive analysis
4. `master_ids.txt` - approved AD ID list for compliance checks

## Commands Implemented

1. `show` — unified inspection with progressive flags (--vars, --http, --components, --var-detail, --http-detail, --full)
2. `validate` — 10 config validation checks from the PD spec
3. `find` — search/browse pages and components with fuzzy search
4. `find-ad-methods` — shallow or recursive AD ID extraction
5. `analyze` — recursive dependency tree + compliance analysis

## Core Behavior Contract

1. Commands are `CommandModule` implementations from `@belzabar/core`.
2. `show` accepts any input: app page URL, PD designer URL, bare hex ID, or component name. Returns overview + optional deep-dive sections via flags.
3. `validate` checks for orphan bindings, unused variables, invalid components (mat-slide-toggle, mat-expansion-panel-header), form field misconfiguration, and more.
4. `find` uses a 7-day cached index with fuzzy search and interactive fzf picker.
5. `find-ad-methods` supports shallow or recursive extraction.
6. `analyze` runs recursive analysis from one root page or default roots and can run compliance checks.
7. `--llm` mode returns envelope JSON through the shared core runner.

## Dual-Format Config Support

PD configs exist in two formats. The parser handles both transparently:

- **New format** (spec-compliant): `variables.userDefined` (array of objects with name/type/initialValue), `httpRequests.userDefined` (array)
- **Old format** (deployed pages): `context.properties` (array of [name, value] tuples), `http` (flat array)

All extraction functions normalize both into common types (`NormalizedVariable`, `NormalizedDerived`, `HttpCallSummary`).

## Parsing and Analysis Model

1. AD IDs are extracted from URL patterns matching `/rest/api/automation/chain/execute/<id>`.
2. Variables are extracted from both `variables.userDefined` (objects) and `context.properties` (tuples).
3. HTTP calls are extracted from both `httpRequests.userDefined` and `http` (flat array).
4. Component dependencies are extracted from layout nodes and filtered through `components.json`.
5. Recursive traversal uses a visited-set to prevent cycles.
6. Input resolution (resolver.ts) auto-detects URLs, hex IDs, and component names.
7. Final reporting includes formatted dependency trees, sorted unique AD IDs, and optional compliance diff.

## Important Files for Agents

1. API adapters: `lib/api.ts`
2. Reference/variable/HTTP extraction: `lib/parser.ts`
3. Input resolution: `lib/resolver.ts`
4. Page/component caching (5 min TTL): `lib/cache.ts`
5. Page/component search index: `lib/page-finder.ts`
6. Recursive traversal: `lib/analyzer.ts`
7. Tree/id reporting: `lib/reporter.ts`
8. Compliance logic: `lib/comparator.ts`
9. PD URL parsing: `lib/url-parser.ts`
10. Types: `lib/types.ts`

## Known Current Gaps

1. Extraction regex assumes alphanumeric AD IDs in execute URLs.
2. `show` metadata fields (`draftId`, `publishedId`, `versionId`) are best-effort and may be `null` when backend responses omit them.
3. `show` app-URL resolution uses `GET /rest/api/public/pagedesigner/deployable/pages?domain=<host>&path=<path>` — the domain must match a registered deployment domain.
4. Validation checks are static pattern-based; they cannot detect runtime-only issues.

## Help Text Standard

All `help.txt` files follow the standard defined in `automation-designer/AGENTS.md`.
Use `belz pd` as the command prefix for all PD commands.

## Safe Change Checklist

1. If adding/removing commands, run `bun run generate` from `cli/` and commit `cli/commands/registry-pd.ts`.
2. Keep `components.json` and `master_ids.txt` semantics documented when formats change.
3. Keep command `help.txt` aligned with real flags and behavior.
4. When adding a command, include a `help.txt` following the standards above.
5. Avoid parser regex changes without validating against real PD payload samples.
6. When modifying parser extraction, test against both config formats (variables vs context, httpRequests vs http).

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this module — new or removed
commands, changed traversal or parsing logic, new lib files, changed output schema, or file
format changes — update this `AGENTS.md` in the same commit. Run `bun run generate` from `cli/`
and commit the updated `registry-pd.ts` alongside your changes.
