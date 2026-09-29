# AGENTS.md — Page Designer (`@belzabar/pd`)

`belz pd <cmd>`: inspect, validate, snapshot, edit and publish Page Designer (PD) pages and
components (symbols). A workspace package with no binary of its own: `apps/cli` imports
`registry.ts` (exported as `@belzabar/pd/registry`); other packages may import `./lib/*`.

**Read `docs/api-notes.md` first**: verified endpoints, the partial-update shape, the lock
lifecycle and the failure-mode catalogue.

## Commands

`registry.ts` is hand-maintained and sorted (`apps/cli/tests/registry.test.ts` checks it
against `commands/`). Each `commands/<name>/` holds `index.ts` (exports `args` + a default
`CommandModule`), `help.txt` and `desc.txt`. `<input>` = app page URL, PD designer URL
(`/ui-designer/page/<id>` or `/ui-designer/symbol/<name>`), bare hex id, or an exact page /
component name (component first, then page; several matches → `PD_NAME_AMBIGUOUS`).

| Command | What it does |
|---|---|
| `belz pd show <input>` | Overview; sections `--vars --http --components --tree --node <id> --var-graph --var-detail <name> --http-detail <N> --find <text\|id\|component>`; `--fields a,b\|all`, `--full`, `--recursive`, `--raw`, `--open`, `--force` |
| `belz pd validate <input>` | Every validator rule on a fresh read; `--recursive` (each used symbol + page↔symbol interfaces), `--full`, `--summary` (warning counts per code, no refs); always reads fresh |
| `belz pd snapshot <input>` | Normalized snapshot (`data.snapshot`), `--out <file>`, or `--compare <file>` |
| `belz pd find [query]` | Fuzzy search over a 7-day cached index; `--components`, `--type page\|component`, `--limit`, `--refresh`, `--open`, `--full` |
| `belz pd find-ad-methods <input>` | AD method ids a page calls; `--recursive`, `--component`, `--force` |
| `belz pd analyze <input...>` | Recursive dependency tree from explicit roots; `--compliance <file>`, `--force` |
| `belz pd page-deps <input>` | page-dependencies summary; `--status PUBLISHED\|DRAFT`, `--full` (raw graph) |
| `belz pd translations <input>` | Release check of phrase keys; `--status`, `--expect-draft <id>`, `--force` |
| `belz pd diff <input> --from <envA> --to <envB>` | Cross-env structural diff (flips `Config.activeEnv` per side, then restores it) |
| `belz pd history <list\|show\|diff\|restore> <pageId>` | Server version history (lives on the PUBLISHED id: `list` on a draft with no versions adds `publishedId` + `hint` and a warning); `restore` copies a version into the DRAFT (`PUT /pages/revert/<draftId>?versionId=`; published page untouched), read back (`PD_RESTORE_VERIFY_FAILED`) |
| `belz pd preflight <pageId> [--overlay <file>]` | Dry run of `save` on the same draft-guarded target (`data.targetId`): parse + validate + plan; never writes |
| `belz pd save <pageId> --overlay <file> \| --config <file>` | Validated, locked save; `--dry-run` |
| `belz pd publish <pageId>` | Draft-guard + diff-aware validate (vs the PUBLISHED version) + locked publish, re-validated on a fresh read inside the lock; `--landing`, `--host <id>` (repeatable) |
| `belz pd lock <acquire\|release\|status [id]>` | Manual lock control (`~/.belz/pd-locks/<env>.json`, atomic 0600; `acquire` of your own lock → `alreadyHeld`; a release answered 200 `false` is `PD_LOCK_RELEASE_FAILED`; a 5xx keeps the record; `status <id>` adds the server's holder) |

Write overrides (`lib/args/common.ts`, on save/publish/history restore): `--force-validation`
(proceed despite validator errors; they land in `bypassedErrors`), `--allow-published` (save /
publish only: write a PUBLISHED page with no linked draft; restore never writes a published row), `--yes`/`-y`.
Write commands have no `--force`; on read commands `--force` means "bypass the cache".

## Contracts

- **Envelope**: `--llm` returns the core envelope (`ok`, `data`, `error.code`, `meta`). Schemas
  are `pd.<cmd>`. Report-style failures use `failWithData` so the report stays in `data`:
  `PD_VALIDATION_FAILED` (validate), `PD_PREFLIGHT_FAILED`, `PD_SNAPSHOT_DIFFERS`,
  `PD_LOCK_RELEASE_FAILED`, `PD_SAVE_VERIFY_FAILED` (save read-back differs from the plan;
  `details.differingPaths`), `PD_TRANSLATIONS_FAILED` (verdict FAIL), `PD_COMPLIANCE_FAILED`
  (rogue AD ids) / `PD_COMPLIANCE_INCOMPLETE` (walk errors → `isCompliant: null`) — all exit 1. A write refused by the validator gate
  (`gateValidation`) is a `CliError` `PD_VALIDATION_FAILED` with the errors in `details.issues`.
- **Error codes** (grep `code: "PD_` for the full set): `PD_NOT_FOUND`, `PD_NAME_AMBIGUOUS`,
  `PD_API_ERROR` / `PD_LOCKED` (409) from `lib/api/client.ts` (non-OK bodies, and non-JSON 2xx bodies via `readJson`, summarised by core
  `httpError`), `PD_DRAFT_LINK_UNRESOLVED`, `PD_PUBLISHED_NO_DRAFT`, `PD_NOT_PUBLISHED`,
  `PD_OVERLAY_INVALID`, `PD_VERSION_NOT_FOUND`, `PD_VERSION_PAGE_MISMATCH`, `PD_RESTORE_VERIFY_FAILED`, `PD_FILE_NOT_FOUND`,
  `PD_FILE_UNREADABLE`, `PD_FILE_UNWRITABLE`, `PD_DIFF_SAME_ENV`, `PD_UNKNOWN_ENV`. Arg errors
  come from core `defineArgs` (`MISSING_INPUT`, `INVALID_FLAGS`, `MISSING_ENV_RANGE`,
  `MISSING_VERSION_RANGE`, `MISSING_ACTION`, …).
- **Writes**: `save` and `publish` set `writes: true`; `history` and `lock` declare it as a
  function (true for `restore`, and for `acquire`/`release`). The runner then requires an explicit `--env`.
  Every write also needs confirmation or `--yes` (`CONFIRMATION_REQUIRED` in `--llm` / non-TTY),
  writes one JSON intent line to stderr (`logIntent` in `lib/edit.ts`) and runs inside `withLock`.
- **Cache** (`lib/cache.ts`): env-scoped core `Cache` at `~/.belz/cache/pages/<env>/<id>.json`,
  shared by pages and components; SWR with 5-min soft / 1-h hard TTL. `withLock` invalidates the
  page after every write; `publish` also drops the published id. `snapshot`, `validate` (root and
  `--recursive` symbols, OTH-R13) and all write paths always read fresh. The recursive walk
  (`analyze`, `find-ad-methods -r`, `show -r`) threads `--force` to every component
  (`cacheDeps` in `lib/analyzer.ts`) and reports `data.cache` `{cache, stale, fresh}` with a
  warning when cached configs were used.
- **Draft/published pairing** (`lib/draft-guard.ts`): the sibling is resolved only through
  `referenceId` (`resolveLinkedPair`), never by name. `resolveWriteTarget` (`lib/edit.ts`) is the
  only way to a writable id.

## Save pipeline (`save`, `preflight`; `publish` / `history restore` share steps 1–3 and 5)

1. `resolveWriteTarget` → draft id (a sibling whose status is `DELETED` counts as no sibling).
2. `withLock(id)` (nested calls are re-entrant; a page recorded by `belz pd lock acquire` still
re-acquires the server lock but is not released). The server answers a re-acquire of a lock
the signed-in user already holds with **HTTP 400** (duplicate key), not 409; `acquireLock` then
reads the page's `pageLockDetails` and returns `heldByMe` when `lockedByCurrentUser` — belz
writes inside that lock and never releases it (manual lock, another belz run, or the user's
own PD editor). Anyone else's lock → `PD_LOCKED` with `details.holder` `{userName, userId,
validTill}` (plus `staleLocalRecord` when a manual record exists).
3. `fetchFresh` inside the lock; `versionDrift` reports a concurrent change. 4. `planSave`
(`lib/serialize/index.ts`) applies the overlay to a **clone of the raw config** (nothing is
rebuilt from parsed lists, so a full save is lossless apart from the edit). 5. `validateEdit`
(before, after): pre-existing issues never block; introduced errors do. 6. PUT: partial ops only
if replaying them reproduces the planned config exactly, else full (`fullSaveReason`); legacy
pages always save full; keys outside the verified shape force full. 7. Read back: `verify` =
`match | mismatch | stale-read` with `source: get | put-response` — the draft GET right after a
PUT is fresh (verified live) and decides; if it ever returns an older version, the PUT's own
answer (the full stored page) decides; `mismatch` fails the save (`PD_SAVE_VERIFY_FAILED`),
`stale-read` (no answer to compare) only warns. The write's own answer is read by `writeAnswer`: an empty/non-JSON
body is `{}`, but a body read that stalls keeps `HTTP_TIMEOUT` (`mayHaveCompleted`) — re-read
before retrying. `publish` validates against `fetchPublishedBaseline` (the GET, superseded by a
newer history version: after a publish without `--host` the published GET keeps serving the
last DEPLOYED version — verified live).

Overlay (`Overlay` in `lib/types/common.ts`; unknown sections, and any shape problem — `null`, a
section that is not an object, a list that is not an array, a missing `name`/`callId`/`id`/`key`,
a bad `operation`/`dataType` — → `PD_OVERLAY_INVALID` listing every problem, from
`lib/serialize/overlay-shape.ts`):

```json
{ "variables":    { "add": [], "update": [], "remove": [] },
  "derived":      { "add": [], "update": [], "remove": [] },
  "httpRequests": { "update": [{ "callId": "…", "request": {}, "handler": {}, "trigger": [] }], "remove": [] },
  "elements":     { "operations": [{ "key": "layout.children[0].props.text", "operation": "UPDATE", "value": "…", "dataType": "STRING" }] },
  "nodes":        { "update": [{ "id": "<nodeId>", "props": {} }], "insert": [], "remove": ["<nodeId>"] },
  "styles":       { "replace": "…css…" } }
```

`nodes.*` addresses layout nodes by id (`lib/serialize/nodes.ts`) and runs after
`elements.operations`. `nodes.update` merges props/field/attrs/events (a `null` value deletes and
forces a full save); `insert` generates missing ids deterministically; insert/remove are full
saves. `belz pd show <input> --find <text>` returns each node's `id` and key `path`. Partial-op
keys use `key` (not `path`) with stringified values. **Partial ops are limited to the key shapes
verified live** (`isVerifiedKeyShape` in `lib/serialize/paths.ts`, evidence in
`tests/fixtures/wire/partial-keys.json`, pinned by `tests/unit/wire-evidence.test.ts`): the
server splits a key on every `.`, reads a trailing `[n]` run as indices and any other segment
as a literal name — `className`, `data-x`, `my key`, `(click)`, `[innerHTML]`, `[(value)]`,
`[student-id]`, `foo[bar]` all work, exactly as belz's `parsePath` reads them. A prop name that
itself contains a dot (`[attr.title]`, `[class.x]`) is a 500 on the wire (the batch is atomic),
so such a `nodes.update` is a full save (`fullSaveReason: "unverified partial-op key shape:
<key>"`) and a raw `elements.operations` key of that shape is refused as not resolving. An op
whose parent object is missing is a silent 200 no-op on the wire; planSave's replay check
already turns that into a full save.

## Validator (`lib/validator/`)

- `catalogue.ts` `PD_RULES`: every code with default severity and source (platform, pd-review
  §3a–3d, figma-to-pd V/T/C/R/H/F/U codes). `commands/validate/help.txt` lists the same codes;
  `tests/unit/validator-lint.test.ts` keeps catalogue, help and emitted codes in sync.
- `rules/existing.ts`, `rules/invariants.ts`, `rules/lint.ts`; `context.ts` builds binding refs,
  defined names and usage. `index.ts`: `validateHydrated`, diff-aware `validateEdit`,
  `ESCALATE_WHEN_INTRODUCED` (warnings that become errors when an edit introduces them).
- `recursive.ts`: `validateRecursive` + `symbolInterfaceIssues` (`SYMBOL_*` codes).
- Calibration rule: real editor output has **0 errors** (`tests/unit/validator-real.test.ts`).
  A rule that fires on real pages is a warning. Live check (2026-09-29, all 633
  drafts, read-only): 53 drafts still have errors, and they are genuine defects (dangling
  bindings such as `studentDob` vs `studentDOB`, duplicate node ids, hand-written or empty
  roots). `publish` gates diff-aware against the PUBLISHED version, so only 4 published pages
  (each with errors introduced since its last publish) plus 19 never-published drafts would
  block. Bindings inside JS comments of multi-line code bodies are ignored (`stripCodeComments`),
  `ref` is a runtime root (`{%ref.Popover_ref_1%}`), and a layout-less component with
  non-empty `styles` is a style-only symbol. Messages must not embed shifting positions (name
  HTTP calls by callId, nodes by id), or `validateEdit` mistakes old issues for new ones.
- Output: `data.issues` = errors; `data.warnings` = `{CODE: {count, refs}}`; `--full` = flat list.

## Snapshot format (`lib/snapshot.ts`)

Keeps entity `{name, entityType, relativeRoute, dynamicRoute, aliasName}` + the inner config;
drops ids, versions, status, timestamps, owners, hostIds, themes, every `_elementId` and empty
editor metadata; sorts keys; turns multi-line strings into `{"$lines": [...]}` (CRLF → LF).
`--compare` rebuilds a page (`pageFromSnapshot`) and reports `page-diff.ts` edit summary plus
`nodesMoved` / `childrenReordered` / `entityChanged`.

## Layout

| Path | Role |
|---|---|
| `lib/api/` | `pdApi` façade (`index.ts`) + raw HTTP client (`client.ts`) |
| `lib/ad-refs.ts` | `loadPdRefs` / `pdRefsOf`: slim index of the `/chain/execute/<uuid>` httpRequests in every PAGE draft + component (cache `pd-ad-refs/`, 1 h); used by `belz ad callers --pd` |
| `lib/types/` | `common.ts` (HydratedPage, ParsedNode, Overlay, ValidationIssue), `wire.ts` (raw API shapes; commands never import it) |
| `lib/parser/` | `parsePage` / `inferEntityType` (`index.ts`), node discriminator (`nodes.ts`, every node carries its key `path`), `variables.ts`, `http.ts`, `refs.ts` |
| `lib/serialize/` | `apply.ts`, `nodes.ts`, `locate.ts`, `paths.ts`, `operations.ts`, `full.ts`, `overlay-shape.ts` (structural overlay check), `index.ts` (`planSave`, `replayOperations`) |
| `lib/validator/` | see above |
| `lib/edit.ts` | write pipeline helpers: `resolveWriteTarget`, `gateValidation`, `versionDrift`, `fetchFresh`, `readJsonFile`, `requireConfirmation`, `logIntent` |
| `lib/lock.ts` | `withLock` + per-env lock file helpers |
| `lib/resolver.ts`, `lib/url-parser.ts` | input → entity (type comes from the server) |
| `lib/extract.ts` | read views (`show` sections, `findNodes`, `adIdsOf`, `childComponentNames`) |
| `lib/page-diff.ts` | the one diff engine (`diffPages`, `editSummary`, `treeShape`) for diff / history diff / save / preflight / snapshot: raw variable entries (every field; duplicate names keyed `name#2`), node own-fields, `nodesMoved`, `childrenReordered` |
| `lib/page-finder.ts` | search index + fuzzy search, `collapsePairs` |
| `lib/analyzer.ts` | recursive analysis + compliance (`--compliance <file>` list of ids) |
| `lib/page-dependencies.ts` | page-deps / translations entity resolution |
| `lib/args/common.ts` | shared `defineArgs` fragments |

Config facts (verified on real pages): derived variables live in
`variables.userDefined` (entries with `from`); `variables.derived` is empty; components carry
`isComponent: true`, pages `relativeRoute` (root `isSymbol` is not decisive); legacy pages use
`context.properties` and a flat `http` array; every real HTTP call is a POST to
`/rest/api/automation/chain/execute/<id>`.

## Adding a command

1. `commands/<name>/index.ts`: `export const args = defineArgs({ command: "belz pd <name>", … })`
   (reuse `lib/args/common.ts` fragments), a default `CommandModule` with `schema: "pd.<name>"`,
   `parseArgs` calling `args.parse`, and `writes` if it changes server state.
2. `help.txt` (Usage / description / Arguments / Flags / Global Flags / Examples) and `desc.txt`
   (`belz pd <name> …  :->  …`, one line per variant). `apps/cli/tests/args-docs.test.ts` fails
   when either drifts from `args`.
3. Add it to `registry.ts` (sorted), then update this file.

## Tests

- `tests/fixtures/real/` — 15 sanitized real pages/components + `manifest.json`
  (includes both duplicate-name "Add Student" pairs and the ~585 KB "Student Application").
  Refresh from the repo root with `bun scripts/fixtures/capture.ts pd <id,id,…>` (read-only).
- `tests/unit/fixtures/` — small hand-written node/page fixtures.
- `tests/unit/helpers/fake-pd.ts` — in-memory PD server over core `fakeFetch` (pages, versions,
  lock, partial/full PUT, publish, revert, name search, page-deps); used command-level via
  `runCommand` in `save-publish`, `history-lock`, `read-paths`, `snapshot` tests.
- Key suites: `real-pages.test.ts` (parse + lossless full save on every real page),
  `validator-real.test.ts` (calibration), `serialize.test.ts`, `nodes-find.test.ts`.
- `tests/fixtures/wire/` — sanitized live wire evidence (2026-09-29, scratch page; ids, hosts
  and names replaced): `partial-keys.json`, `lock.json`, `revert.json`, `publish.json`. Pinned by
  `tests/unit/wire-evidence.test.ts`; `fake-pd.ts` models the same behaviour (key parsing, lock
  400/409/`pageLockDetails`, release `true`/`false`, revert on the draft, PUT answers the page).
- Live write suite (opt-in): `apps/cli/tests/live/pd-page.live-write.test.ts` —
  `BELZ_LIVE=<env> BELZ_LIVE_WRITE=1 BELZ_LIVE_PD_PAGE=<draftId> bun test apps/cli/tests/live/pd-page.live-write.test.ts`
  (plus whatever `describeLiveWrite` requires). Use a dedicated scratch page: it saves, locks,
  publishes WITHOUT a host and restores a version, then puts the original raw config back,
  re-publishes, and checks `snapshot --compare`.

## Known gaps

1. `pd diff` across envs reports HTTP calls as changed when their env-local AD ids differ.
2. App-URL resolution needs a registered deployment domain; the validator is static only.
3. The 409 body for a lock held by ANOTHER user was never captured (one account); belz names
   the holder from the page's `pageLockDetails`, not from that body.
4. `PUT /pages/revert/<publishedId>?versionId=` (which belz never sends) rewrites the live row
   AND flips its status to DRAFT (self-referencing). No API was found that sets a row back to
   PUBLISHED (publish, full PUT and `metaDataUpdate` keep the status); a sibling left `DELETED`
   is treated as absent by the draft guard.

## Maintainer rule

Any meaningful change here (commands, flags, output schema, lib files, pipeline behaviour)
updates this file, `registry.ts` and the command's `help.txt` / `desc.txt` in the same commit.
