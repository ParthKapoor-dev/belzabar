# Page Designer — belz-cli API notes

**Belz-owned cheatsheet.** Read this first, then the expertly `page-designer/SKILL.md` for full
component/rule reference. This file records belz's operational contract — what we rely on, what we
have verified live, and how the PD module is structured inside belz.

---

## Verified endpoints (nsm-dev probed during planning)

All paths are relative to `/rest/api/pagedesigner`. Auth: `Authorization: Bearer {token}`.

### Reads

| Verb | Path | Purpose | Status |
|---|---|---|---|
| GET | `/pages/{id}` | Full page body. `configuration` is a stringified JSON. | Used today. |
| GET | `/pages?status=DRAFT|PUBLISHED&pageType=PAGE|COMPONENT&name=...` | List/search pages. | Used today. |
| GET | `/pages/history?pageId={id}` | **Version history** — returns array of `{id (=versionId), pageId, status, partialUpdate, updatedAt, updatedBy, userName}`. **Observed behavior**: entries are only recorded for PUBLISHED-status pages. Pure DRAFT pages (no published sibling) return `[]` even after multiple saves (belz confirmed via live `save` that bumped versionId but produced 0 history entries). A page gets history once it has been published at least once; thereafter both the draft AND published variants may accumulate entries (all entries tagged `status: "PUBLISHED"` in the snapshots we've seen). | **Live-verified**: 538 entries on published `NCDMV NSM`; 0 entries on fresh draft even after belz-driven save. |
| GET | `/pages/version/{versionId}` | Full page body at a specific version. | **Live-verified**. |
| GET | `/pages/{id}?version={versionId}` | Same as above, alternate form. | **Live-verified**. |
| GET | `/pages/{id}?includeVersions=true` | Full body variant (observed in JS but not needed — prefer `/pages/version/`). | Verified 200. |
| GET | `/deployable/pages?domain=&path=` | App-URL → reference page ID. | Used today. |

### Writes

| Verb | Path | Body | Notes |
|---|---|---|---|
| PUT | `/pages/{id}` | Full: `{status, partialUpdate:false, configuration:"<stringified JSON>"}`<br>Partial: `{status, partialUpdate:true, pageElementOperations:[...]}` | `partialUpdate` is **required** — omitting it returns 400. |
| PUT | `/pages/lock/{id}` | Both acquire AND release use query param: `?pageLockAction=ACQUIRED` / `?pageLockAction=RELEASED`. Body must NOT carry `pageLockAction` — server rejects with 400 "Required request parameter 'pageLockAction' is not present". (The Angular `httpPut(url, {pageLockAction:...})` reads the second arg as query params, not body.) 409 means locked by another session. |
| POST | `/pages/{id}/publish` | `{landingPage: boolean, hostIds?: "id1,id2"}` | From JS: `httppost(${base}/pages/${u}/publish, {landingPage, hostIds}, {})`. Not UI-only — real API. |
| PUT | `/pages/revert/{versionId}` | Body `{}` (empty) | From JS: `restoreVersion(u, I={})`. |
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
- The PD editor auto-acquires when open — if acquire returns 409, either ask the user to close
  the editor or (belz:) read the owner info from the response and abort gracefully.
- Lock owner info is returned in the 409 body — surface it to the user.

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

## Failure-mode catalog (mirrors expertly `page-designer/SKILL.md` §Common errors)

These are the classes of corruption belz must either prevent (validator rule) or surface cleanly
(`show`/`validate` output). When adding a validator rule, cite the matching failure mode here.

### Silent-page-crash class (validator: `error`)

| Failure | belz rule code |
|---|---|
| `exp-form-field` uses `props` instead of `field` (#1 silent crash) | `FORM_FIELD_PROPS` |
| Root `layout` is `{children: [...]}` instead of a full root div node | `ROOT_LAYOUT_MALFORMED` |
| Root `layout` on symbol missing `isSymbol:true`, or using `unSelectable:true` | `ROOT_LAYOUT_MALFORMED` |
| `children` is an object (numeric keys) instead of array | `CHILDREN_NOT_ARRAY` |
| `<button>` with `[className]` dynamic binding renders invisible | `BUTTON_DYNAMIC_CLASSNAME` |
| `mat-slide-toggle` — no runtime declaration | `INVALID_SLIDE_TOGGLE` |
| `mat-expansion-panel-header` — not a valid PD component | `INVALID_EXPANSION_HEADER` |
| Variable `initialValue` is an array — `ArrayNode cannot be cast to ObjectNode` | `ARRAY_INITIAL_VALUE` |
| Derived var used inside `[innerHTML]` / `innerHTML` / `[textContent]` — renders empty | `DERIVED_IN_INNERHTML` |
| `exp-form-field` with `type:"phone"` — renders with 0 height | `PHONE_FIELD_TYPE` |
| Binding `{%varName%}` references an undefined variable | `ORPHAN_BINDING` |
| Two nodes share `id` or `_elementId` | `DUPLICATE_ELEMENT_IDS` |

### Warnings (validator: `warn`)

| Failure | belz rule code |
|---|---|
| `exp-data-table` missing `datasourceState` binding | `TABLE_NO_DATASOURCE` |
| `exp-data-table` has both dynamic `[columns]` and variable with `initialValue` | `DYNAMIC_COLS_INITIAL` |
| Variable defined but never referenced | `UNUSED_VARIABLE` |
| HTTP call triggers `onInit` but no `onInit` variable exists | `MISSING_ONINIT_VAR` |
| HTTP call has empty `eventMeta: {}` — shows "undefined - undefined" in PD UI | `EMPTY_EVENT_META` |
| Raw HTML form element (`<input>`, `<select>`, `<textarea>`, `<table>`) — should be a PD component | `CUSTOM_HTML_IN_COMPONENT` |
| `isSymbol:true` reference whose name doesn't resolve in this env | `SYMBOL_UNRESOLVED` |

### Not validator-checkable (documentation only — surface in `show`)

These are runtime or CSS-scoping issues. belz can surface them in the `show` output but not gate
saves, because they depend on deployed state.

- CSS classes missing `.latest-version` prefix → silently not applied.
- `type:"radio"` on `exp-form-field` without `[options]` data → 0-height render.
- Select `labelKey` / `valueKey` mismatch with API response shape.
- `cellLayout` `{%$item.value%}?.field` vs `{%$item.field%}` (the latter fails).
- Angular Material NG0901 tab-switch errors — non-blocking, ignore.

---

## Belz module architecture (post-refactor)

```
page-designer/
├── lib/
│   ├── args/common.ts              → parseCommonArgs(argv) → {force, yes, dryRun, rest}
│   ├── types/{common,wire}.ts      → HydratedPage / ParsedNode / wire shapes
│   ├── parser/{index,nodes,variables,http,refs}.ts
│   ├── validator/{index,rules/{existing,invariants}.ts}
│   ├── serialize/{full,operations,index}.ts
│   ├── api/{index,client}.ts       → pdApi façade + raw HTTP wrappers
│   ├── draft-guard.ts              → resolveDraftTarget()
│   └── lock.ts                     → withLock(pageId, fn)
└── commands/
    ├── show/ validate/ find/ find-ad-methods/ analyze/   (reads — backward compatible)
    ├── history/ preflight/ lock/                         (reads — new)
    └── save/ publish/                                    (writes — new)
```

### Invariants

1. Commands import **only** from `lib/types/common.ts`. Never `wire.ts`.
2. Every PUT goes through `withLock`. Acquire/release is opaque to the caller.
3. Every save runs `validateHydrated(patched)` before network. Errors block unless `--force`.
4. Overlay is declarative. The serializer is pure: `(HydratedPage, Overlay) → operations[] | fullBody`.
5. `raw` is preserved on every `ParsedNode`, `PageVariable`, `PageHttpRequest`, and on
   `HydratedPage` itself. Round-trip safety is non-negotiable.

### Adding a new failure-mode rule

1. Pick a rule code (`UPPER_SNAKE_CASE`).
2. Cite the failure-mode row in this file.
3. Add the rule function to `lib/validator/rules/invariants.ts` (or `existing.ts` if it's one of
   the 10 we already had).
4. Add a fixture under `tests/unit/fixtures/` named `node-<scenario>.json` or
   `page-<scenario>.json`.
5. Add a test in `tests/unit/validator-invariants.test.ts` asserting (a) the rule fires on the bad
   fixture and (b) does NOT fire on a matching good fixture.

### Adding a new write endpoint

1. Add the raw wrapper to `lib/api/client.ts`.
2. Add a façade method to `lib/api/index.ts`.
3. Wrap every caller in `withLock` if the endpoint is a mutation on a specific page.
4. Document the exact body/query/response shape here.

---

## Save strategy (partial vs full)

`lib/serialize/index.ts:serialize(page, overlay)` picks the method:

- **Partial** — when the overlay contains only:
  - `variables.update` (update existing variables' initialValue/type/description)
  - `httpRequests.update` (update existing request bodies/handlers)
  - Discrete `elements.operations[]` (dot-notation path edits)
  - `styles.replace` → single operation with `key: "styles"`
- **Full** — when any of:
  - `variables.add` / `variables.remove`
  - `derived.add` / `derived.remove` / `derived.update`
  - `httpRequests.add` / `httpRequests.remove`
  - Node structural changes that aren't expressible as scalar leaf edits

Rationale: partial updates are faster, safer (surgical), and play nicely with concurrent edits.
Full updates are required when the config's shape changes non-trivially — attempting to patch
`variables.userDefined[n]` when `n` is outside the current array length silently drops.

---

## Version history UX

Backed by three server endpoints. belz exposes them as:

- `belz pd history list <pageId>` → table of `{versionId, status, partial, updatedAt, user}`.
- `belz pd history show <pageId> --version <vid>` → parses the version body with the same parser
  as `show`, runs the validator (read-only), emits the same presenter.
- `belz pd history diff <pageId> --from A --to B` → fetches both, parses both, diffs structure
  (variables added/removed, nodes added/removed/kind-changed, HTTP calls added/removed, root-level
  counts). Not a textual diff of the JSON.
- `belz pd history restore <pageId> --version <vid>` → `withLock(pageId, () => PUT /pages/revert/<vid>)`
  → re-fetches and emits new versionId in the envelope.

**History is server-side.** belz does **not** maintain local snapshots.

Empty history array on brand-new pages is a normal result (see `dummy-testing` — 0 entries until
it's saved at least once). `history list` exits 0 with an empty array.

---

## Test page

`https://nsm-dev.nc.verifi.dev/ui-designer/page/4f126300499e4d83cd07a35b4d9af9e7`

- ID: `4f126300499e4d83cd07a35b4d9af9e7`
- Name: `dummy-testing`
- Status: DRAFT
- VersionId: `406403` (as of 2026-04-23)
- Config size: 685 bytes
- 2 user-defined variables, 0 HTTP calls, 0 direct child components
- Unauth; user-sanctioned for full CLI testing on the dev environment.
