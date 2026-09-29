# `lib/parser/`: raw page → `HydratedPage`

Pure functions (no network, no cache) that turn a PD page body into the in-memory
`HydratedPage` ([`../types/common.ts`](../types/common.ts)). Problems never throw: they
accumulate as `parseWarnings` on the page.

| File | What it does |
|---|---|
| `index.ts` | `parsePage(raw)` (parses the stringified `configuration`, runs the others) and `inferEntityType` |
| `nodes.ts` | Layout walker → discriminated `ParsedNode` tree; `walkParsed`, `findNode` |
| `variables.ts` | User-defined and derived variables from both config formats; `isDerivedEntry` |
| `http.ts` | HTTP calls from `httpRequests.userDefined` and the legacy flat `http` array, in order, tagged with their bucket; extracts the AD method id from `/chain/execute/<id>` |

## Contracts

- **`raw` is kept** on the page and on every node, variable and HTTP call, so unknown shapes
  round-trip. The serializer edits the raw config; it never rebuilds it from parsed lists.
- **Entity type is the server's**: `isComponent`, then `pageType`, then a `relativeRoute`, and
  only then the config (`layout.isSymbol`, `inputs`/`events`).
- **Node kinds**, first match wins: `isSymbol: true` → `SYMBOL`; `exp-form-field` →
  `FORM_FIELD`; `exp-data-table` → `DATA_TABLE`; `button` → `BUTTON`; a flex/grid `div` without
  innerHTML → `LAYOUT_CONTAINER`; else `GENERIC`. Every node carries its key `path`
  (`layout.children[1]…`), which overlays and `show --find` use.
- **Derived variables** in real editor output live in `variables.userDefined` (entries with
  `from` and `spec`) and parse as derived with `location: "userDefined"`; entries of
  `variables.derived` / `context.derived` get `location: "derived"`.
- Legacy pages (`context.properties` tuples, flat `http`) are normalized to the same shapes.

Tests: `tests/unit/parser-*.test.ts` and `real-pages.test.ts` (every real fixture parses).
Up: [`../README.md`](../README.md).
