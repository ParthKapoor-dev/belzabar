# Page Designer — belz-cli API notes

**Belz-owned cheatsheet.** Read this first, then the Expertly platform's Page Designer
documentation for the full component/rule reference. This file records belz's operational contract — what we rely on, what we
have verified live, and how the PD module is structured inside belz.

---

## Verified endpoints (probed live during planning)

All paths are relative to `/rest/api/pagedesigner`. Auth: `Authorization: Bearer {token}`.

### Reads

| Verb | Path | Purpose | Status |
|---|---|---|---|
| GET | `/pages/{id}` | Full page body. `configuration` is a stringified JSON. | Used today. |
| GET | `/pages?status=DRAFT|PUBLISHED&pageType=PAGE|COMPONENT&name=...` | List/search pages. | Used today. |
| GET | `/pages/history?pageId={id}` | **Version history** — returns array of `{id (=versionId), pageId, status, partialUpdate, updatedAt, updatedBy, userName}`. **Observed behavior**: entries are only recorded for PUBLISHED-status pages. Pure DRAFT pages (no published sibling) return `[]` even after multiple saves (belz confirmed via live `save` that bumped versionId but produced 0 history entries). A page gets history once it has been published at least once; thereafter both the draft AND published variants may accumulate entries (all entries tagged `status: "PUBLISHED"` in the snapshots we've seen). | **Live-verified**: 538 entries on published `Acme Portal`; 0 entries on fresh draft even after belz-driven save. |
| GET | `/pages/version/{versionId}` | Full page body at a specific version: `id` = the OWNING page (the published row), `referenceId` = its draft. Version ids are global — check ownership. | **Live-verified** (2026-09-27). |
| GET | `/pages/{id}?version={versionId}` | Same as above, alternate form. | **Live-verified**. |
| GET | `/pages/{id}?includeVersions=true` | Full body variant (observed in JS but not needed — prefer `/pages/version/`). | Verified 200. |
| GET | `/deployable/pages?domain=&path=` | App-URL → reference page ID. | Used today. |

### Writes

| Verb | Path | Body | Notes |
|---|---|---|---|
| PUT | `/pages/{id}` | Full: `{status, partialUpdate:false, configuration:"<stringified JSON>"}`<br>Partial: `{status, partialUpdate:true, pageElementOperations:[...]}` | `partialUpdate` is **required** — omitting it returns 400. |
| PUT | `/pages/lock/{id}?pageLockAction=ACQUIRED\|RELEASED` | none | Query parameter only; a body-only `pageLockAction` is rejected with 400. See "Lock protocol" for the answers (verified live 2026-09-29). |
| POST | `/pages/{id}/publish?landingPage=&hostIds=id1,id2` | none | Parameters go in the QUERY STRING (a JSON body is ignored: the page is published but not deployed). The response body is the published page with the authoritative post-publish versionId. Live-verified 2026-09-29 (`tests/fixtures/wire/publish.json`): each publish adds one history entry on the published id; without `hostIds` the published GET keeps serving the last DEPLOYED version (history and `/pages/version/<vid>` have the new one); with `hostIds` the GET shows it at once. |
| PUT | `/pages/revert/{draftId}?versionId={vid}` | Body `{}` | **Live-verified 2026-09-29** (`tests/fixtures/wire/revert.json`). Copies the version's config into the DRAFT row (new draft versionId) and answers `{id, versionId, configuration, status, referenceId}`; the PUBLISHED row and history are untouched. The PD UI sends the same (`status === PUBLISHED ? referenceId : id`). `/pages/revert/{vid}` is a 400 ("Required request parameter 'versionId'"). Given the PUBLISHED id it rewrites the live row with no publish and no history entry and flips it to `status: DRAFT` (self-referencing) — never send that. |
| PUT | `/pages/phrases/{id}` | Translation partial-update. Same shape as partial. | **Out of scope for this phase.** |

### Partial-update operation shape

```json
{
  "key": "layout.children[0].props.innerHTML",
  "value": "New Text",
  "operation": "UPDATE",
  "dataType": "STRING"
}
```

- **Field is `key`**, not `path`.
- **Key parsing (live-verified 2026-09-29, `tests/fixtures/wire/partial-keys.json`)**: the server
  splits the key on EVERY `.`; a trailing `[n]` run is array indices; any other segment is a
  literal property name — `[innerHTML]`, `[(value)]`, `[student-id]`, `(click)`, `data-x`,
  `my key`, `2col`, `foo[bar]` all store under exactly that name. A prop name containing a dot
  (`[attr.title]`) is split and answers **HTTP 500**; a batch is atomic (nothing stored). An op
  whose parent object does not exist answers **200 and stores nothing** (silent no-op; the
  versionId still bumps). `UPDATE` on a missing key creates it. `NUMBER`/`BOOLEAN` values are
  stored typed. The PUT answer is the full stored page (`configuration` included), and an
  immediate GET of the draft returns the same config and versionId.
- `value` is **always a string**: numbers stringified, booleans stringified, arrays/objects JSON.stringified.
- `operation`: `"CREATE"` (new field) or `"UPDATE"` (existing).
- `dataType`: `"STRING" | "NUMBER" | "BOOLEAN" | "ARRAY" | "OBJECT"`.
- Payload wrapper: `{status, partialUpdate:true, pageElementOperations:[op, op, ...]}`.
- Key-path examples:
  - `layout.props.className`
  - `layout.children[1].children[0].props.disabled`
  - `variables.userDefined`
  - `variables.userDefined[2].initialValue`
  - `httpRequests.userDefined`
  - `styles`

### Lock protocol

```
# Acquire
PUT /pages/lock/{id}?pageLockAction=ACQUIRED
Authorization: Bearer ...

# Release
PUT /pages/lock/{id}?pageLockAction=RELEASED
Authorization: Bearer ...
```

- **Both** verbs use the query string. Do not put `pageLockAction` in the body — server returns
  400 "Required request parameter 'pageLockAction' is not present".
- Answers (live-verified 2026-09-29, `tests/fixtures/wire/lock.json`): ACQUIRED on a free page →
  200 `true`; ACQUIRED on a page the signed-in user already holds → **HTTP 400** (database
  duplicate key on `(key, type, status)`), not 409; RELEASED → 200 `true` when released, 200
  `false` when nothing of yours was held. A lock lasts ~24 h.
- A locked page's GET carries `pageLockDetails` `{status: "ACQUIRED", userName, createdBy,
  validTill, lockedByCurrentUser}` — belz uses it to tell "mine" (reuse, never release) from
  "someone else's" (`PD_LOCKED`, holder named). The 409 body for another user's lock was not
  captured (one account).
- Writes do not require the lock server-side (a partial PUT without it succeeds); belz takes it
  anyway so concurrent editors are detected.
- The PD editor auto-acquires when open.

### Save → refresh behaviour

- PD editor preview does **not** pick up API saves on browser F5. The in-app refresh button is
  required. Belz doesn't need to care, but document for users probing the test page.

---

## Config shape (page vs symbol)

### Page

```
{ id, name, status, versionId, updatedAt, updatedBy, createdAt, createdBy,
  aliasName, hostIds, ownerId, themes, relativeRoute, dynamicRoute, authenticated,
  configuration: "<stringified JSON>" }
```

Parsed `configuration` has:
```
{
  "__version": 5,
  "layout": { "id", "name":"div", "props":{"layout":{...}}, "children":[...], "_elementId", "unSelectable":true, "__LAYOUT_CONFIG_METADATA":{} },
  "styles": "",
  "variables": { "generated":[], "userDefined":[], "derived":[] },
  "httpRequests": { "generated":[], "userDefined":[] }
}
```

### Symbol / component

```
{
  "__version": 5,
  "inputs": ["prop1", "prop2"],
  "events": ["event1"],
  "helpText": {},
  "httpRequests": {...},
  "layout": { "id", "name":"div", "isSymbol": true, ... },   // ← isSymbol, NOT unSelectable/__LAYOUT_CONFIG_METADATA
  "styles": "",
  "variables": {...}
}
```

### Old-format pages (legacy)

Some pages still use: `context.properties: [[name, value], ...]` instead of `variables.userDefined`
and `http: [...]` instead of `httpRequests.userDefined`. The parser normalizes both.

---

## Failure-mode catalog (mirrors the platform docs' common errors)

These are the classes of corruption belz must either prevent (validator rule) or surface cleanly
(`show`/`validate` output). When adding a validator rule, cite the matching failure mode here.

### Silent-page-crash class (validator: `error`)

| Failure | belz rule code |
|---|---|
| `exp-form-field` uses `props` instead of `field` (#1 silent crash) | `FORM_FIELD_PROPS` |
| Root `layout` is not a div node; page root without `unSelectable:true` | `ROOT_LAYOUT_MALFORMED` |
| Component root missing `isSymbol:true` (real components ALSO set `unSelectable:true` — allowed) | `ROOT_LAYOUT_MALFORMED` |
| Configuration is not valid JSON | `INVALID_JSON` |
| `children` is an object (numeric keys) instead of array | `CHILDREN_NOT_ARRAY` |
| `mat-slide-toggle` — no runtime declaration | `INVALID_SLIDE_TOGGLE` |
| `mat-expansion-panel-header` — not a valid PD component | `INVALID_EXPANSION_HEADER` |
| `exp-form-field` with `type:"phone"` — renders with 0 height | `PHONE_FIELD_TYPE` |
| Binding `{%varName%}` (outside `variables.generated`) whose ROOT variable is undefined | `ORPHAN_BINDING` |
| Two nodes share `id` or `_elementId` | `DUPLICATE_ELEMENT_IDS` |

### Warnings (validator: `warn`)

Calibrated against real pages: these fire on live, working pages. The first four become
errors when an edit INTRODUCES them (`validateEdit`; `escalate` in `lib/validator/catalogue.ts`).

| Failure | belz rule code |
|---|---|
| Undefined variable inside an editor-generated form config | `ORPHAN_BINDING` (warn) |
| Derived var used inside `[innerHTML]` / `innerHTML` / `[textContent]` — renders empty | `DERIVED_IN_INNERHTML` |
| Variable `initialValue` is an array — `ArrayNode cannot be cast to ObjectNode` | `ARRAY_INITIAL_VALUE` |
| `<button>` with `[className]` dynamic binding renders invisible | `BUTTON_DYNAMIC_CLASSNAME` |
| `exp-data-table` missing `datasourceState` binding | `TABLE_NO_DATASOURCE` |
| `exp-data-table` has both dynamic `[columns]` and variable with `initialValue` | `DYNAMIC_COLS_INITIAL` |
| Variable defined but never referenced | `UNUSED_VARIABLE` |
| HTTP call triggers `onInit` but no `onInit` variable exists | `MISSING_ONINIT_VAR` |
| HTTP call has empty `eventMeta: {}` — shows "undefined - undefined" in PD UI | `EMPTY_EVENT_META` |
| Raw HTML form element (`<input>`, `<select>`, `<textarea>`, `<table>`) — should be a PD component | `CUSTOM_HTML_IN_COMPONENT` |

### Not validator-checkable (documentation only — surface in `show`)

These are runtime or CSS-scoping issues. belz can surface them in the `show` output but not gate
saves, because they depend on deployed state.

- CSS classes missing `.latest-version` prefix → silently not applied.
- `type:"radio"` on `exp-form-field` without `[options]` data → 0-height render.
- Select `labelKey` / `valueKey` mismatch with API response shape.
- `cellLayout` `{%$item.value%}?.field` vs `{%$item.field%}` (the latter fails).
- Angular Material NG0901 tab-switch errors — non-blocking, ignore.

---

## Belz module architecture

See `../AGENTS.md` (Directory Map, Safe-Edit Invariants). Adding a rule: put it in
`lib/validator/rules/invariants.ts`, catalogue its code in `lib/validator/catalogue.ts`, cite
the failure mode here, add a true-positive test in
`tests/unit/validator-real.test.ts`, and keep the real-page calibration at 0 errors.

## Save strategy (partial vs full)

`lib/serialize/index.ts:planSave(page, overlay)`:

- **Partial** — `variables.update`, `httpRequests.update` (request url/body/method,
  handler success/error/inProgress, trigger, triggerFilter, responseTransformSpec),
  `elements.operations`, `styles.replace`. Keys use the RAW array index (derived vars interleaved
  in `userDefined` and duplicate names count). `operation` is `UPDATE` when the key exists, else
  `CREATE`. The plan is only partial when the ops, replayed on the raw config, reproduce the
  edited config exactly.
- **Verified key shapes only** — a partial op is only sent when every dot segment of its key is
  a shape verified live (see "Key parsing" above): plain names with `[n]` indices, and literal
  binding props (`[innerHTML]`, `[(value)]`, `(click)`, `data-x`, …). A prop name that itself
  contains a dot (`[attr.title]`) cannot be addressed (500), so such an edit is saved in full.
- **Full** — `variables.add/remove`, `derived.*`, `httpRequests.add/remove`, legacy-format pages,
  or ops that would not cover the edit (e.g. a parent object that does not exist yet). The body is
  the page's own raw config with only the edit applied (lossless otherwise).

## Version history UX

Backed by three server endpoints. belz exposes them as:

- `belz pd history list <pageId>` → table of `{versionId, status, partial, updatedAt, user}`.
- `belz pd history show <pageId> --version <vid>` → parses the version body with the same parser
  as `show`, runs the validator (read-only), emits the same presenter.
- `belz pd history diff <pageId> --from A --to B` → fetches both, parses both, diffs structure
  (variables added/removed, nodes added/removed/kind-changed, HTTP calls added/removed, root-level
  counts). Not a textual diff of the JSON.
- `belz pd history restore <pageId> --version <vid>` → checks ownership, resolves the owner's
  linked DRAFT, validates the version against it (diff-aware), locks the draft, re-validates on a
  fresh read, `PUT /pages/revert/<draftId>?versionId=<vid>`, reads the draft back
  (`data.verify`; `PD_RESTORE_VERIFY_FAILED` on a mismatch). The published page is untouched —
  `belz pd publish <draftId>` makes the restore live.

**History is server-side.** belz does **not** maintain local snapshots.

Empty history on a draft id is normal: history is recorded on the PUBLISHED row (one
live page: draft 0 versions, published 104). `history list` exits 0 with an empty array.

---

## Test page

`https://dev.example.test/ui-designer/page/4f126300499e4d83cd07a35b4d9af9e7`

- ID: `4f126300499e4d83cd07a35b4d9af9e7`
- Name: `dummy-testing`
- Status: DRAFT
- VersionId: `406403` (as of 2026-04-23)
- Config size: 685 bytes
- 2 user-defined variables, 0 HTTP calls, 0 direct child components
- Unauth; user-sanctioned for full CLI testing on the dev environment.
