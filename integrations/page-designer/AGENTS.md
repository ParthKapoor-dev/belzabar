# AGENTS.md — Page Designer

## Purpose

This directory provides the PD command modules and lib for the Page Designer. It provides CLI tools for deep inspection of PD configurations:

1. Inspect page/component configs — variables, HTTP calls, component trees, bindings
2. Validate configs against known failure patterns (severities calibrated on real pages)
3. Extract referenced AD method IDs
4. Search pages and components from a cached index
5. Recursively analyze page/component dependency trees with compliance checks

This is the `@belzabar/pd` workspace package — no standalone binary. All commands are served via `belz pd <cmd>` (unified binary built from `apps/cli/`, which imports this package's `registry.ts`).

## Tech

1. Runtime: Bun + TypeScript
2. Commands registered in: `registry.ts` (static, sorted; exported as `@belzabar/pd/registry`)
3. Shared runner/framework: `@belzabar/core`

## Command Routing

**Reads:**
```
belz pd show <INPUT>             # unified page/component inspection; --tree / --node / --var-graph
belz pd validate <INPUT>         # validator (exit 1 / ok:false on errors)
belz pd find [query]             # search pages/components
belz pd find-ad-methods <INPUT>  # extract AD method IDs (id, name or URL)
belz pd analyze <INPUT...>       # recursive dependency (+ --compliance <file>)
belz pd history <action>         # server-backed version history (list/show/diff/restore)
belz pd diff <INPUT> --from <envA> --to <envB>   # cross-environment structural diff
belz pd preflight <pageId>       # dry-run: parse + validate + (optional) overlay, no save
```

**Writes:**
```
belz pd save <pageId> --overlay <file>   # validated overlay save (partial or full)
belz pd save <pageId> --config <file>    # raw full-config save (escape hatch)
belz pd publish <pageId>                 # validate + POST /publish
belz pd lock <acquire|release|status>    # manual lock control
```

When adding or removing PD commands, update `registry.ts` (keep it sorted).

## Directory Map

1. `commands/` - command modules (`index.ts`, `help.txt`, `desc.txt`)
2. `lib/api/` - `pdApi` façade (`index.ts`) + raw HTTP client (`client.ts`). Non-OK responses go through core `httpError` (summarised body) and keep the codes `PD_API_ERROR` / `PD_LOCKED`; the name search and app-URL lookup no longer turn 401/5xx into "not found" (PD-18). `releaseLock` returns a boolean.
3. `lib/types/` - `common.ts` (HydratedPage, ParsedNode, Overlay, ValidationIssue; re-exports the raw bodies commands pass through), `wire.ts` (raw API shapes). Commands never import `wire.ts`.
4. `lib/parser/` - the ONE parser stack: `index.ts` (`parsePage`, `inferEntityType`), `nodes.ts` discriminator, `variables.ts`, `http.ts`, `refs.ts`. (`parser/legacy.ts`, `types/legacy.ts` are gone.)
5. `lib/extract.ts` - read views on a HydratedPage: `adIdsOf`, `childComponentNames` (starts at root.children, PD-25), and the `show` views (vars, http summary/detail, var detail, component tree).
6. `lib/validator/` - `index.ts` (`validateHydrated`, diff-aware `validateEdit`, `ESCALATE_WHEN_INTRODUCED`), `context.ts` (binding refs, defined names, usage), `rules/existing.ts`, `rules/invariants.ts`.
7. `lib/serialize/` - `apply.ts` (overlay → edited clone of the RAW config; unknown targets → `PD_OVERLAY_INVALID`), `locate.ts` (raw-index lookup), `paths.ts` (key paths + wire value encoding), `operations.ts` (partial ops), `full.ts` (full body = raw config), `index.ts` (`planSave`).
8. `lib/edit.ts` - shared write pipeline: `resolveWriteTarget` (draft-guard + `--allow-published`), `gateValidation`, `versionDrift`, `fetchFresh`, `readJsonFile` (PD-17), `requireConfirmation`, `logIntent` (`[belz pd write]` stderr line).
9. `lib/draft-guard.ts` - `resolveDraftTarget`. The draft/published sibling is resolved ONLY via `referenceId` (`resolveLinkedPair`, injectable `DraftGuardDeps`) — never by name. Missing status, dangling/wrong-status/contradicting link → `PD_DRAFT_LINK_UNRESOLVED`. `lib/page-dependencies.ts` (translations, page-deps) uses the same resolver.
10. `lib/lock.ts` - `withLock` (re-entrant: skips acquire/release when this process or `belz pd lock acquire` already holds the lock; invalidates the page cache), plus the per-env lock-file helpers used by `pd lock`.
11. `lib/args/common.ts` - `defineArgs` fragments: `PD_FORCE_FLAG` (reads: bypass cache), `PD_WRITE_OVERRIDE_FLAGS` (`--force-validation`, `--allow-published`, deprecated `--force`), `writeOverrides()`, `PD_YES_FLAG`, `PD_DRY_RUN_FLAG`, `PD_DEP_STATUS_FLAG`, `PD_INPUT_POSITIONAL`.
12. `lib/resolver.ts` + `lib/url-parser.ts` - input → page body. Entity type from the server; names resolve exactly (component first, then page; several → `PD_NAME_AMBIGUOUS`).
13. `lib/cache.ts` - env-scoped SWR page cache (pages and components share it); `invalidatePageCache(id | ids)`.
14. `lib/analyzer.ts` - recursive analysis (`analyzeItem` with injectable deps, collected `errors`), tree formatting, compliance (`loadMasterIds`, `verifyCompliance`).
15. `lib/page-diff.ts` - the ONE diff engine (`diffPages`, `isIdentical`, `editSummary`, `editSummaryLines`) used by `diff`, `history diff`, `save`, `preflight`.
16. `lib/page-finder.ts` - 7-day search index, fuzzy search (`searchPageIndex` → `{matches, total}`), `collapsePairs`.
17. `docs/api-notes.md` - **read this first** — verified endpoints, partial-update shape, failure-mode catalog

No `components.json` / `master_ids.txt`: recursion follows every symbol reference, and the
compliance list is an explicit `--compliance <file>` (PD-13 / F21).

## Commands Implemented

**Reads:**
1. `show` — overview + `--vars/--http/--components/--var-detail/--http-detail/--tree/--node/--var-graph/--full/--recursive/--raw/--open`. Derived vars are the userDefined entries with `from`.
2. `validate` — every rule; ok:false `PD_VALIDATION_FAILED` (exit 1, report in `data`) on errors. `--force` bypasses the cache.
3. `find` — fuzzy page/component search; `list` returns all rows unless `--limit`; component draft/published pairs are one row; `totalMatches`/`total` count before the limit.
4. `find-ad-methods` — any input (id/name/URL), `--component`, `--recursive` (with `errors`).
5. `analyze <input...> [--compliance <file>]` — explicit roots only.
6. `history <action>` — list, show, diff, restore. show/diff/restore refuse a version not owned by `<pageId>` or its sibling (`PD_VERSION_PAGE_MISMATCH`). History lives on the PUBLISHED id.
7. `diff <input> --from <envA> --to <envB>` — per-env resolution + `diffPages`. Flips `Config.activeEnv` per side and restores it.
8. `preflight <pageId> [--overlay <file>]` — dry-run; with an overlay validated exactly like `save`. ok:false `PD_PREFLIGHT_FAILED` (exit 1) on errors.

**Writes (all: confirmation or `--yes`, `[belz pd write]` intent line, lock):**
9. `save <pageId>` — see Safe-Edit Invariants. Data: `strategy`, `fullSaveReason`, `operationsPreview`, `diffSummary`, `validation`, `versionDrift`, `result`, `verify`, `bypassedErrors`.
10. `publish <pageId>` — draft-guard, validator gate, locked POST, then drops the cache of the draft AND the published page.
11. `lock <acquire|release|status>` — manual lock control (`~/.belz/pd-locks/<env>.json`); a refused release is ok:false `PD_LOCK_RELEASE_FAILED`.
12. `history restore` — validates the version against the current page (diff-aware), locks the owning page and its linked draft, needs `--allow-published` when the owner is PUBLISHED (the revert endpoint rewrites the owner).

## Core Behavior Contract

1. Commands are `CommandModule` implementations from `@belzabar/core`.
2. `show` accepts any input: app page URL, PD designer URL, bare hex ID, or component name. Returns overview + optional deep-dive sections via flags.
3. `validate` checks the rules listed in `commands/validate/help.txt`. Calibration (PD-5): real editor output (the 15 fixtures) has 0 errors — `tests/unit/validator-real.test.ts` enforces it. A rule that fires on real pages is a warning; if it is still worth blocking when an edit introduces it, add it to `ESCALATE_WHEN_INTRODUCED`.
4. `find` uses a 7-day cached index with fuzzy search and interactive fzf picker.
5. `find-ad-methods` supports shallow or recursive extraction.
6. `analyze` runs recursive analysis from the given roots and can run compliance checks against a file.
7. `--llm` mode returns envelope JSON through the shared core runner.

## Config Shapes (verified on real sems-dev pages)

- **Variables**: `variables.userDefined` holds plain variables AND derived variables (entries with
  a `from` array, `spec`, `filterFn`, `compileType:"DERIVED"`); `variables.derived` is empty on
  every real page. `variables.generated` is editor-owned (form configs, `$$navigation*`,
  `requestEvent*`). Legacy pages use `context.properties` tuples and a flat `http` array.
- **Entity type**: component bodies carry `isComponent: true`; pages carry `relativeRoute`. The root
  `isSymbol` flag is NOT decisive (real pages copy it). Every root is `div` + `unSelectable:true`;
  component roots also set `isSymbol:true`; about half the pages have no root `_elementId`.
- **Bindings**: `{%a.b[0]%}` refers to variable `a`; `$item`/`$row`/`$event`/`$$…`/`pageContext`
  are runtime scope; component `inputs` are defined names; names may carry stray spaces.
- **History**: recorded on the PUBLISHED row; `GET /pages/version/<vid>` returns the owning page
  (`id`) with `referenceId` = the draft.
- **Name search** (`GET /pages?name=`): exact match, returns pages AND components (`isComponent`).

## Important Files for Agents

1. **`docs/api-notes.md`** — start here. Verified endpoints, partial-update shape, lock lifecycle, failure-mode catalog.
2. API façade: `lib/api/index.ts` (pdApi.*). Raw client: `lib/api/client.ts`.
3. Unified types: `lib/types/common.ts`. Never import `wire.ts` from commands.
4. Parser: `lib/parser/index.ts` (parsePage façade); `nodes.ts` is the discriminator.
5. Validator: `lib/validator/index.ts` (validateHydrated). Rules in `rules/{existing,invariants}.ts`.
6. Serializer: `lib/serialize/index.ts` (`planSave`), `apply.ts`, `operations.ts`, `full.ts`, `locate.ts`, `paths.ts`. Write pipeline: `lib/edit.ts`.
7. Draft-guard: `lib/draft-guard.ts`. Lock: `lib/lock.ts`.
8. Input resolution: `lib/resolver.ts`. Cache: `lib/cache.ts`. Search index: `lib/page-finder.ts`.
9. Recursive traversal + compliance: `lib/analyzer.ts`. Read views: `lib/extract.ts`. Diff: `lib/page-diff.ts`.

## Tests and Fixtures

- `tests/unit/fixtures/` — small hand-written node/page fixtures.
- `tests/fixtures/real/` — 15 real sems-dev pages/components (raw `GET /pages/{id}`,
  sanitized, `manifest.json`), incl. both duplicate-name "Add Student" pairs and
  "Student Application" `4cba8f39…` (~585 KB). Refresh with
  `bun scripts/fixtures/capture.ts pd <id,id,…>` from the repo root.
- `tests/unit/real-pages.test.ts` — parse every real page, server entity type, lossless full
  save (unedited, and edited = only the edit differs), referenceId pairing.
- `tests/unit/validator-real.test.ts` — calibration (0 errors on real pages), true positives,
  `validateEdit`.
- `tests/unit/helpers/fake-pd.ts` — in-memory PD server over fakeFetch (pages, versions, lock,
  partial/full PUT, publish, revert, name search). Used by `save-publish`, `history-lock`,
  `read-paths` tests (command-level, via `runCommand`).
- No live PD writes were done in Stage 6: there is no safe API to create a throwaway page
  (a page needs hosts/route), so the write paths are covered by the fake server only.

## Safe-Edit Invariants (DO NOT BYPASS)

1. **Every write goes through `withLock(pageId, fn)`**, and `save` fetches, applies and validates
   INSIDE the lock on the latest version (PD-4; `versionDrift` reports a concurrent change).
2. **Every write is validated.** `save`/`history restore` use `validateEdit(before, after)`:
   pre-existing issues never block, introduced errors do. `publish` validates the draft.
   `--force-validation` is the only bypass (errors land in `bypassedErrors`). `--force` is a
   deprecated alias of `--force-validation` ONLY (warns).
3. **`resolveWriteTarget` / `resolveDraftTarget` is the only path to a writable id.** A PUBLISHED
   page with no linked draft needs `--allow-published` (PD-6).
4. **The overlay edits a clone of the raw config.** Nothing is rebuilt from parsed lists, so a
   full save is lossless apart from the edit (PD-22). Targets are located by raw index (PD-2).
5. **A partial save is used only when its ops, replayed, reproduce the planned config exactly**
   (PD-3); otherwise a full save (`fullSaveReason`). Legacy-format pages always save full.
6. **Partial-update operations use `key` (NOT `path`) with stringified values.** A dot segment that
   is not `name[0]` is a literal key (`props.[innerHTML]`). See `docs/api-notes.md`.
7. After the PUT, `save` reads the page back (`verify: match | mismatch | stale-read`).

## Known Current Gaps

1. AD-ID extractor regex assumes alphanumeric execute-URL ids.
2. App-URL resolution requires a registered deployment domain.
3. Validator is static — runtime-only issues (e.g. missing `.latest-version` CSS scoping) are noted in `docs/api-notes.md` but not gate-checked.
4. What `PUT /pages/revert/<vid>` rewrites (owner vs draft) is not verified live; restore locks both and requires `--allow-published` for a PUBLISHED owner.
5. How the server parses partial-op keys with bracketed prop names (`props.[innerHTML]`) is not verified live.
6. `pd diff` across envs reports HTTP calls as changed when their env-local AD ids differ.

## Help Text Standard

All `help.txt` files follow the standard defined in `automation-designer/AGENTS.md`.
Use `belz pd` as the command prefix for all PD commands.

## Safe Change Checklist

1. If adding/removing commands, update `registry.ts` in the same commit.
2. Re-run `tests/unit/validator-real.test.ts` when touching a rule: real pages must stay at 0 errors.
3. Keep command `help.txt` aligned with real flags and behavior.
4. When adding a command, include a `help.txt` following the standards above.
5. Avoid parser regex changes without validating against real PD payload samples.
6. When modifying parser extraction, test against both config formats (variables vs context, httpRequests vs http).

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this module — new or removed
commands, changed traversal or parsing logic, new lib files, changed output schema, or file
format changes — update this `AGENTS.md` (and `registry.ts` for command changes) in the same commit.
