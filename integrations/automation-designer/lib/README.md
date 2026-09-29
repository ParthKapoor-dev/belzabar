# lib — the Automation Designer library

Everything the `belz ad` commands share. Other workspaces import it as
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
| `cache.ts` | `CacheManager`: the parsed-method cache; `invalidate` also marks the method-index entry dirty. |
| `hydrator.ts` | V1 service-definition lookup and cache; `buildServiceResolver` for the V1 parser. |
| `categories.ts` | One category model joining the two id spaces (chain category and automation system): `fetchCategories`, `findCategory`, `requireChainCategory`. |
| `method-finder.ts` | The cached method index behind `find` and `callers` (core `finderIndexStore`): build, search, dirty and gone marks, `addMethodToIndex`. |
| `callers.ts` | `ad callers`: the reverse index (AD methods; PD pages and components via `@belzabar/pd/lib/ad-refs`), with honest coverage reporting. |
| `view-fetch.ts` | `fetchViewMethod` (fresh V2 read, V1 fallback) for `show --compact` / `--story` and `outputs`; `fetchMethodChecked` (V1 read confirmed on V2, so soft-deleted methods are `METHOD_NOT_FOUND`). |
| `method-view.ts` | `compactMethod` / `renderCompact` (`show --compact`: `{view:"compact", name, category, state, version, uuid, in, out, vars, steps[], blocks?}`, one line per step) and `storyMarkdown` (`show --story`: `{view:"story", name, uuid, markdown}`). |
| `compact.ts` | Output trimming for `--llm` payloads: `pruneEmpty`, `oneLine`, `abbreviate`, `htmlToText`. |
| `api-shape.ts` | `child-info --shape`: the part of a callee contract needed to wire a step, plus its auth accounts. |
| `history.ts` | `getVersionOf` / `sideOf`: read version N from the chain (draft or published) the uuid names. |
| `fingerprint.ts` | `fingerprintMethod`: a behaviour hash that ignores env-local ids and bookkeeping; `methodDiffView`, `diffPaths`. |
| `trace.ts` | `traceMethod`: where a method's dev history has reached on every env (`ad trace`, `release matrix`). |
| `test-run.ts` | `runInlineTest`: one `/chain/test` run → status, trace, outputs map; `diffOutputs` for `--compare-published`. |
| `payload-builder.ts` | `buildV1TestPayload`: the one `/chain/test` body (`test`, `run-suites`, test-case runs). |
| `test-suite.ts` | `loadTestSuite`: one summary of a method's suite for `test-cases` and `test-case list`. |
| `input-collector.ts` | Test input values from prompts, files and `--input k=v`. |
| `stream-parser.ts` | `application/stream+json` responses (`run --stream`). |
| `error-parser.ts` | Java exceptions returned with HTTP 200, and per-step failure status. |
| `base64.ts` | `encodeBase64`, `decodeBase64Strict` (plain text is never mis-decoded). |

## Contracts

- **Draft guard.** Every write that changes a method calls `resolveDraftTarget(uuid, version)`
  first. A draft uuid is used as is; a PUBLISHED uuid is switched to its linked draft
  (`switchedFromPublished: true`). It refuses with `PUBLISHED_NO_DRAFT` (create the draft in the
  UI), `STATE_UNKNOWN` (fails closed) or `REFERENCE_NOT_DRAFT`. A save body whose uuid resolves
  to PUBLISHED would silently overwrite production.
- **Method refs.** Any uuid argument goes through `resolveMethodRef` from
  `@belzabar/core/platform` (any uuid spelling or AD URL → 32 hex, else `INVALID_UUID`).
- **Fingerprints** compare V2 or history bodies only. Cross-env noise is normalised: numeric
  `…Id`s and other `…Uuid`s, default `encodedBase64` / `runAsync` / `required` false, db
  `account` ids (hashed by name), whitespace in service and category names, a method output
  `fieldCode` equal to its key. `tests/fixtures/cross-env` holds real dev/qa pairs.
- **`trace`** switches the global active env while it runs (restored afterwards), so calls must
  not run concurrently.

## Caching

All caches are core `Cache` instances under `~/.belz/cache/`, env-scoped.

| Cache | Location | TTL | Evicted by |
|---|---|---|---|
| Methods | `methods/<env>/<uuid>.json` | 5 min soft (stale-while-revalidate), 1 h hard | save, publish, delete, history restore; `show --force` bypasses. A V1 parse with unresolved services is never cached. |
| Service definitions | `definitions/<env>/<automationId>.json` | 1 h | — |
| Method index | `method-finder/index-v1-<env>.json`, `dirty-<env>.json`, `gone-<env>.json` | 7 days (`callers` rebuilds after 24 h; a partial index after 15 min) | `find --refresh`, `callers --refresh`, `ad import`. belz writes mark a uuid dirty (`callers` re-reads it); `create` adds the new draft; a V2 `METHOD_NOT_FOUND` marks it gone. |
| Caller refs | `callers/` (30 days, keyed by uuid and `updatedOn`), `callers-errors/` (1 day) | — | `callers --refresh` |
| Published history bodies | `history-versions/<env>/` | 30 days (immutable) | — |
| Validator L4 | `api-contracts/`, `service-accounts/` | 1 h | — |

Up: [`../README.md`](../README.md)
