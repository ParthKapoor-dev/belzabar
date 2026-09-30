# `lib/`: shared Page Designer code

Everything the `belz pd` commands share. Other packages may import any module as
`@belzabar/pd/lib/<path>`.

## In this directory

| Path | What it is |
|---|---|
| [`api/`](./api/README.md) | `pdApi` façade + raw HTTP client; the verified endpoint contract |
| [`args/`](./args/README.md) | Shared `defineArgs` flag fragments |
| [`parser/`](./parser/README.md) | Raw page body → `HydratedPage` (pure) |
| [`serialize/`](./serialize/README.md) | Overlay → edited config → partial ops or full save |
| [`types/`](./types/README.md) | In-memory types (`common.ts`) and wire shapes (`wire.ts`) |
| [`validator/`](./validator/README.md) | Rule catalogue, rules, diff-aware edit gate, recursive symbol check |
| `ad-refs.ts` | Slim index of every `/chain/execute/<uuid>` call in PAGE drafts and components (cached 1 h); read by `belz ad callers --pd` |
| `analyzer.ts` | Recursive walk (`analyze`, `find-ad-methods -r`, `show -r`): components used, AD ids, `--compliance` |
| `cache.ts` | Env-scoped page-config cache (`~/.belz/cache/pages/<env>/<id>.json`, core `PAGE_CACHE_DIR`) with stale-while-revalidate; `belz migrate run` evicts its target env's entries |
| `draft-guard.ts` | Draft/published pairing through `referenceId` |
| `edit.ts` | Write-pipeline helpers: `resolveWriteTarget`, `fetchFresh`, `fetchPublishedBaseline`, `gateValidation`, `versionDrift`, `requireConfirmation`, `logIntent`, `readJsonFile` |
| `extract.ts` | Read views over a page: `show` sections, `findNodes`, `adIdsOf`, `childComponentNames` |
| `lock.ts` | `withLock` and the manual-lock record (`~/.belz/pd-locks/<env>.json`) |
| `page-dependencies.ts` | Entity resolution + phrase-key checks for `page-deps` / `translations` |
| `page-diff.ts` | The one diff engine: `diffPages`, `editSummary`, `differingPaths` |
| `page-finder.ts` | The `find` index (7 days) and fuzzy search; `collapsePairs` hides a PUBLISHED row whose draft is listed |
| `resolver.ts`, `url-parser.ts` | `<input>` (URL, id, name) → fetched page; the entity type comes from the server |
| `snapshot.ts` | Normalized snapshots and `--compare` |

## Read path

`resolveInput` → `cachedFetchPageConfig[Swr]` (or a fresh fetch) → `parsePage` →
`extract.ts` / `validator/` / `page-diff.ts`. The cache serves a stale entry (flagged) past the
5-min soft TTL and refetches only on a miss, past the 1-h hard TTL, or with `--force`. The
recursive walk passes `--force` down to every component (`cacheDeps`) and reports
`data.cache` `{cache, stale, fresh}` with a warning when cached configs were used.

## Write pipeline

Used by `save` and `preflight` in full, and by `publish` / `history restore` for steps 1–3 and 5:

1. `resolveWriteTarget` (`edit.ts` over `draft-guard.ts`) → the draft id. The pair is linked by
   each row's `referenceId`, never by name (names are not unique). A PUBLISHED input follows its
   link to the draft; no link needs `--allow-published`; a broken or mismatched link is refused;
   a sibling whose status is `DELETED` counts as no sibling.
2. `withLock(id)` (`lock.ts`). Re-entrant within one process. The server answers a re-acquire of
   the caller's own lock with HTTP 400; `acquireLock` then reads `pageLockDetails` and, when
   `lockedByCurrentUser`, writes inside that lock and never releases it (manual lock, another
   belz run, or the user's own editor). Anyone else's lock → `PD_LOCKED` with
   `details.holder`. The page cache is invalidated after every write.
3. `fetchFresh` inside the lock; `versionDrift` reports a concurrent change since the snapshot.
4. `planSave` applies the overlay to a clone of the raw config
   ([`serialize/`](./serialize/README.md)).
5. `validateEdit(before, after)`: pre-existing issues never block, introduced errors do
   (`gateValidation`; `--force-validation` lists them in `bypassedErrors`). `publish` compares
   against `fetchPublishedBaseline`: the published GET, superseded by a newer history version
   (after a publish without `--host` the GET keeps serving the last deployed version).
6. PUT: partial ops only when replaying them reproduces the plan exactly, else a full save
   (`fullSaveReason`).
7. Read back: `verify` is `match | mismatch | stale-read` with `source: get | put-response`.
   The draft GET right after a PUT is fresh and decides; if it returns an older version, the
   PUT's own answer (the full stored page) decides. `mismatch` fails with
   `PD_SAVE_VERIFY_FAILED` (`details.differingPaths`); `stale-read` only warns. A write whose
   answer stalls keeps `HTTP_TIMEOUT` (`mayHaveCompleted`): re-read before retrying.

Before the lock, the command plans and validates once on the guard's snapshot so it fails fast,
then asks for confirmation and writes one JSON intent line to stderr (`logIntent`).

## Snapshot format (`snapshot.ts`)

Keeps the entity `{name, entityType, relativeRoute, dynamicRoute, aliasName}` and the inner
config. Drops ids, versions, status, timestamps, owners, `hostIds`, `themes`, every `_elementId`
and empty editor metadata; sorts object keys (arrays keep their order); turns multi-line strings
into `{"$lines": [...]}` (CRLF → LF). `--compare` rebuilds a page (`pageFromSnapshot`) and
reports the `page-diff.ts` edit summary plus `nodesMoved`, `childrenReordered` and
`entityChanged`.

## Diff engine (`page-diff.ts`)

Shared by `diff`, `history diff`, the save/preflight edit summary and `snapshot --compare`.
Compares whole raw variable entries (duplicate names keyed `name#2`), derived entries, HTTP
calls by `callId`, and node own-fields (children excluded), plus moved nodes and reordered
children.

## Config facts (verified on real pages)

- Derived variables live in `variables.userDefined` (entries with `from`); `variables.derived`
  is empty.
- Components carry `isComponent: true`, pages a `relativeRoute`; the root's `isSymbol` is not
  decisive.
- Legacy pages use `context.properties` and a flat `http` array.
- Every real HTTP call is a POST to `/rest/api/automation/chain/execute/<id>`.

Up: [`../README.md`](../README.md).
