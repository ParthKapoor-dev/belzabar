# lib — the Automation Designer library

Everything the `wi-impl ad` commands share. Other workspaces import it as
`@belzabar/ad/lib/<path>` (for example `release` uses `trace.ts`).

## Subdirectories

| Directory | Contents |
|---|---|
| [`api/`](api/README.md) | Wire clients: the `adApi` façade, V1 and V2 routes, change notes. V1 vs V2 differences. |
| [`args/`](args/README.md) | Shared flag fragments (`--v2`, `--yes`, `--note`) and the write confirmation gate. |
| [`types/`](types/README.md) | The version-neutral `HydratedMethod` / `ParsedStep` model and the raw wire shapes. |
| [`parser/`](parser/README.md) | V1 / V2 body → `HydratedMethod`; step classification by service identity. |
| [`serialize/`](serialize/README.md) | Pure edits onto a live V2 body: leaf overlay, structural ops, the compact step format. |
| [`save/`](save/README.md) | The V2 write pipeline (save, create, delete), the validation gate, compiled-cache eviction. |
| [`validate/`](validate/README.md) | The pre-save validator (L1–L4) and the advisory `ad lint` rules. |
| [`test-cases/`](test-cases/README.md) | `--expect`, persisted test cases, case files, suite runs. |
| [`sql/`](sql/README.md) | `ad sql`: DB selection, the read-only gate, executors, the TUI. |

## Files

| File | Contents |
|---|---|
| `draft-guard.ts` | `resolveDraftTarget`: the only way a write picks its target (see below). |
| `cache.ts` | `CacheManager`: the parsed-method cache (directory from core `METHOD_CACHE_DIR`); `invalidate` also marks the method-index entry dirty. |
| `hydrator.ts` | V1 service-definition lookup and cache; `buildServiceResolver` for the V1 parser. |
| `categories.ts` | One category model joining the two id spaces (chain category and automation system): `fetchCategories`, `findCategory`, `requireChainCategory`. |
| `method-finder.ts` | The cached method index behind `find` and `callers` (core `finderIndexStore`): build, search, dirty and gone marks, `addMethodToIndex`, `categoryResolverFor` / `cachedCategoryResolver` (a category alias → canonical name, from the cached index only). |
| `callers.ts` | `ad callers`: the reverse index (AD methods; PD pages and components via `@belzabar/pd/lib/ad-refs`), with honest coverage reporting; its body reader (`readBodyCached`: V2 body, the V1 parse when V2 refuses it; `pool`) is shared with `grep.ts`. |
| `grep.ts` | `ad grep`: the searchable texts of a method (`stepTextsOf` / `methodTextsOf`: SQL and code decoded, SpEL, call targets, descriptions; test cases read fresh), line matching; reads bodies through `callers.ts`' `readBodyCached` (per-version cache `cache/grep-texts`). |
| `view-fetch.ts` | `fetchViewMethod` (fresh V2 read, V1 fallback) for `show --compact` / `--story` and `outputs`; `fetchMethodChecked` (V1 read confirmed on V2, so soft-deleted methods are `METHOD_NOT_FOUND`). |
| `method-view.ts` | `compactMethod` / `renderCompact` (`show --compact`: `{view:"compact", name, category, state, version, uuid, summary?, methodDescription?, in, out, vars, defaults?, steps[], callees?, blocks?}`, one line per step) and `storyMarkdown` (`show --story`: `{view:"story", name, uuid, markdown}`). Cuts end `…(+N, use --full)`; conditions are never cut. A `CategoryResolver` (from `method-finder.ts` `cachedCategoryResolver`) gives callees their canonical category. |
| `compact.ts` | Output trimming for `--llm` payloads: `pruneEmpty`, `oneLine`, `abbreviate`, `htmlToText`; `escapeRichText` for description writes. |
| `api-shape.ts` | `child-info --shape`: the part of a callee contract needed to wire a step, plus its auth accounts. |
| `history.ts` | `getVersionOf` / `sideOf`: read version N from the chain (draft or published) the uuid names. |
| `fingerprint.ts` | `fingerprintMethod`: a logic hash that ignores descriptions, internal ids / links and bookkeeping; `methodDiffView` (the `ad diff` view: no ids), `diffPaths`. |
| `trace.ts` | `traceMethod`: where a method's dev history has reached on every env (`ad trace`, `release matrix`). |
| `test-run.ts` | `runInlineTest`: one `/chain/test` run → status and HTTP status, trace (times in ms; a loop step's ns time corrected; async steps `dispatched (async)`), per-step outputs and rendered SQL, server timing, outputs map; `diffOutputs` for `--compare-published`. |
| `compare-run.ts` | `compareRuns` for `--compare-published`: status, HTTP status, failing step and error, then outputs (`--ignore` paths dropped, `--ignore-order` sorts lists); `parseIgnorePath`. |
| `repeat.ts` | `repeatStats`: min / median / max of `--repeat` run times. |
| `payload-builder.ts` | `buildV1TestPayload`: the one `/chain/test` body (`test`, `run-suites`, test-case runs). |
| `publish-report.ts` | What `ad publish` changes besides the body: the published test suite (`readSuitesBeforePublish` / `reportPublishedSuite`: the server replaces it with a copy of the draft's, new ids, published-only cases deleted) and the caller steps that pass an input the draft dropped (`removedInputs`, `findRemovedInputCallers`, through `callers.ts`). |
| `test-suite.ts` | `loadTestSuite`: one summary of a method's suite for `test-cases` and `test-case list` (`full`: each case's inputs and assertions too). |
| `input-collector.ts` | Test input values from prompts, files and `--input k=v`; `resolveInputValues` checks a values object against the method (also used per `--cases` row). |
| `stream-parser.ts` | `application/stream+json` responses (`run --stream`). |
| `error-parser.ts` | Java exceptions returned with HTTP 200, and per-step failure status. |
| `run-context.ts` | What a `test` / `run` executes: `ranVersionOf` (`PUBLISHED v5`), `unpublishedDraftOf` (a published uuid whose draft differs, by fingerprint), `calleeDrafts` (called methods whose draft differs: a call runs the published copy), `asyncSteps`, `runWarnings`, `testRouteInputWarnings` (inputs the test route hands over differently from `run`). Best effort: a failed read gives no warning. |
| `exec-error.ts` | `executionError`: a non-2xx execution answer (`run`, `test`) → CliError whose message is the status, failing step and the method's own message; JSON text in the body decoded; a body over 16 KB saved whole under `~/.wi-impl/logs/errors/` (`details.bodyFile`). |
| `base64.ts` | `encodeBase64`, `decodeBase64Strict` (plain text is never mis-decoded). |

## Contracts

- **Draft guard.** Every write that changes a method calls `resolveDraftTarget(uuid, version)`
  first. A draft uuid is used as is; a PUBLISHED uuid is switched to its linked draft
  (`switchedFromPublished: true`). It refuses with `PUBLISHED_NO_DRAFT` (create the draft in the
  UI), `STATE_UNKNOWN` (fails closed) or `REFERENCE_NOT_DRAFT`. A save body whose uuid resolves
  to PUBLISHED would silently overwrite production.
- **Method refs.** Any uuid argument goes through `resolveMethodRef` from
  `@belzabar/core/platform` (any uuid spelling or AD URL → 32 hex, else `INVALID_UUID`).
- **Fingerprints** compare V2 or history bodies only and cover logic only: descriptions
  (method summary/description, step and field descriptions) and every internal id, uuid or
  link (a callee's API output uuids, a method output's step link) are left out; a V1 callee's
  `automationApiUuid` is the one id kept. Cross-env noise is normalised: numeric
  `…Id`s, default `encodedBase64` / `runAsync` / `required` false, db
  `account` ids (hashed by name), whitespace in service and category names, a method output
  `fieldCode` equal to its key. `tests/fixtures/cross-env` holds real dev/qa pairs.
- **`trace`** switches the global active env while it runs (restored afterwards), so calls must
  not run concurrently.

## Caching

All caches are core `Cache` instances under `~/.wi-impl/cache/`, env-scoped.

| Cache | Location | TTL | Evicted by |
|---|---|---|---|
| Methods | `methods/<env>/<uuid>.json` | 5 min soft (stale-while-revalidate), 1 h hard | save, publish, delete, history restore, and `wi-impl migrate run` for its target env (core `invalidateEntityCache`); `show --force` / `--step N` bypass. `show` serves a cached copy only after a raw V1 read confirms the server's `version` is the same (else it reads fresh). A V1 parse with unresolved services is never cached. |
| Service definitions | `definitions/<env>/<automationId>.json` | 1 h | — |
| Method index | `method-finder/index-v1-<env>.json`, `dirty-<env>.json`, `gone-<env>.json` | 7 days (`callers` rebuilds after 24 h; a partial index after 15 min) | `find --refresh`, `callers --refresh`, `ad import`. wi-impl writes (and `migrate run` on its target env) mark a uuid dirty through core `markMethodIndexDirty` (`callers` re-reads it); `create` adds the new draft; a V2 `METHOD_NOT_FOUND` marks it gone. |
| Caller refs | `callers/` (30 days, keyed by uuid and `updatedOn`), `callers-errors/` (1 day; a V2 400 is never kept: it falls back to V1) | — | `callers --refresh` |
| Grep step texts | `grep-texts/` (30 days, keyed by uuid and `updatedOn`; failures share `callers-errors/`) | — | `grep --refresh` retries failures |
| Published history bodies | `history-versions/<env>/` | 30 days (immutable) | — |
| Validator L4 | `api-contracts/`, `service-accounts/` | 1 h | `ad publish` drops the published method's own contract; `ad save` re-reads a contract online before it refuses on it |

Up: [`../README.md`](../README.md)
