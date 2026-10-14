# `lib/api/`: the PD HTTP layer

`pdApi` is the only way commands and lib code talk to the Page Designer server. It also records
the wire contract wi-impl relies on, verified live against a scratch page (evidence in
[`../../tests/fixtures/wire/`](../../tests/fixtures/wire), pinned by
`tests/unit/wire-evidence.test.ts`).

## In this directory

| File | What it is |
|---|---|
| `index.ts` | `pdApi` façade: reads, history, writes, locks. Import from here. |
| `client.ts` | One raw function per endpoint: no parsing, no business logic. Only `index.ts` imports it. |

The façade never locks: writes are wrapped in `withLock` ([`../lock.ts`](../lock.ts)) by the
caller, so a flow can batch several PUTs in one lock window.

## Errors

A non-OK response becomes `PD_LOCKED` (409) or `PD_API_ERROR` (anything else), with the body
summarised by core `httpError` (HTML → `<title>`, truncated, secrets redacted). A non-JSON 2xx
body (an SSO or maintenance page) is also `PD_API_ERROR`. A write that returned 2xx but whose
body cannot be read keeps the core error code with `details.mayHaveCompleted: true`: re-read the
page before retrying. An empty or non-JSON write answer counts as `{}`.

## Endpoints

All under `/rest/api/pagedesigner`, Bearer auth through core `apiFetch` (refreshes on 401).

| Verb | Path | Used for |
|---|---|---|
| GET | `/pages/{id}` | Full page; `configuration` is stringified JSON; `pageLockDetails` when locked |
| GET | `/pages?…` (`name`, `status`, `pageType`, `apiInfoLevel`) | Name lookup and the `find` index |
| GET | `/pages/page-dependencies?…` | `page-deps`, `translations` |
| GET | `/pages/history?pageId={id}` | Version list. Recorded on the PUBLISHED row: a never-published draft has none |
| GET | `/pages/version/{versionId}` | A version's full body. `id` is the owning (published) row, `referenceId` its draft. Version ids are global, so ownership is checked |
| PUT | `/pages/{id}` | Save. Full: `{status, partialUpdate: false, configuration}`. Partial: `{status, partialUpdate: true, pageElementOperations}`. `partialUpdate` is required (400 without it). Answers the full stored page |
| POST | `/pages/{id}/publish?landingPage=&hostIds=a,b` | Publish. Parameters go in the query string (a JSON body is ignored). Adds one history entry on the published row. Without `hostIds` the page is not deployed and the published GET keeps serving the last deployed version |
| PUT | `/pages/revert/{draftId}?versionId={vid}` | Copy a version into the DRAFT (new draft versionId); published row and history untouched |
| PUT | `/pages/lock/{id}?pageLockAction=ACQUIRED\|RELEASED` | Locks (below) |

App URLs resolve through the public `/rest/api/public/pagedesigner/deployable/pages?domain=&path=`
(→ the reference page id).

**Never** send `/pages/revert/{publishedId}`: it rewrites the live row with no publish and no
history entry and flips it to `status: DRAFT`. No API is known that flips it back.

## Partial-update operations

```json
{ "key": "layout.children[0].props.innerHTML", "value": "New Text", "operation": "UPDATE", "dataType": "STRING" }
```

- The field is `key`, not `path`. `value` is always a string (numbers, booleans and JSON
  stringified); `NUMBER`/`BOOLEAN` are stored typed. `operation` is `CREATE` or `UPDATE`
  (`UPDATE` on a missing key creates it). `dataType` is `STRING | NUMBER | BOOLEAN | ARRAY | OBJECT`.
- The server splits a key on every `.`; a trailing `[n]` run is array indices; any other segment
  is a literal name (`[innerHTML]`, `[(value)]`, `(click)`, `data-x`, `my key`, `foo[bar]` all
  work).
- A name containing a dot (`[attr.title]`) is split and answers **500**; a batch is atomic.
- An op whose parent object does not exist answers **200 and stores nothing** (the versionId
  still bumps). [`../serialize/`](../serialize/README.md) guards against both.
- The GET right after a PUT returns the same config and versionId.

## Lock protocol

- Both actions use the query parameter; a body-only `pageLockAction` is a 400.
- ACQUIRED on a free page → 200 `true`. On a page the signed-in user already holds → **HTTP 400**
  (duplicate key), not 409; `acquireLock` then reads `pageLockDetails` and returns `heldByMe`.
  Anyone else's lock → `PD_LOCKED` naming the holder (the 409 body itself was never captured).
- RELEASED → 200 `true` when released, 200 `false` when nothing of yours was held.
  `releaseLock` never throws for a refusal; a 5xx is `released: null`.
- `pageLockDetails` = `{status, userName, createdBy, validTill, lockedByCurrentUser}`. A lock
  lasts about 24 h; the PD editor acquires one when a page is opened. The server does not
  require the lock for a write; wi-impl takes it to detect concurrent editors.
- The PD editor preview does not show API saves on a browser reload; use its own refresh button.

## Config shape

```
page:      { id, name, status, versionId, referenceId, relativeRoute, dynamicRoute, aliasName,
             hostIds, themes, ownerId, created*/updated*, configuration: "<stringified JSON>" }
config:    { __version, layout: {id, name: "div", props, children, _elementId, unSelectable: true, …},
             styles, variables: {generated, userDefined, derived},
             httpRequests: {generated, userDefined} }
component: the same config plus inputs, events, helpText; the root layout has isSymbol: true
legacy:    context.properties: [[name, value], …] and a flat http: […]; the parser normalizes both
```

Raw types: [`../types/wire.ts`](../types/wire.ts). Up: [`../README.md`](../README.md).
