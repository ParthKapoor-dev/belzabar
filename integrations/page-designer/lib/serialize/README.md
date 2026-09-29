# `lib/serialize/`: overlay → save plan

Turns an overlay (the edit file `save` / `preflight` take) into the edited page and decides how
to send it: partial `pageElementOperations` when they provably reproduce the edit, else a full
configuration PUT. Pure: no network.

## In this directory

| File | What it does |
|---|---|
| `index.ts` | `planSave(before, overlay)` → `{strategy: "partial", operations, patched}` or `{strategy: "full", configurationString, patched, fallbackReason}`; `replayOperations` |
| `overlay-shape.ts` | `assertOverlayShape`: structural check, every problem reported at once as `PD_OVERLAY_INVALID` |
| `apply.ts` | `applyOverlay`: applies the overlay to a deep clone of the RAW config; unknown targets are refused |
| `locate.ts` | Finds variables / derived / HTTP calls by their raw array index; legacy-format detection |
| `nodes.ts` | Node-id ops (`nodes.update/insert/remove`) on the raw clone, and partial ops for updates |
| `operations.ts` | Overlay → partial ops; `fullSaveReason` |
| `paths.ts` | Key paths (`parsePath`, `setPath`, `hasPath`), value encoding, `isVerifiedKeyShape` |
| `full.ts` | `serializeFull`: the stringified inner config of the patched page |

## Overlay

```json
{ "variables":    { "add": [], "update": [], "remove": [] },
  "derived":      { "add": [], "update": [], "remove": [] },
  "httpRequests": { "add": [], "update": [{ "callId": "…", "request": {}, "handler": {}, "trigger": [] }], "remove": [] },
  "elements":     { "operations": [{ "key": "layout.children[0].props.text", "operation": "UPDATE", "value": "…", "dataType": "STRING" }] },
  "nodes":        { "update": [{ "id": "<nodeId>", "props": {} }], "insert": [{ "parentId": "…", "index": 0, "node": {} }], "remove": ["<nodeId>"] },
  "styles":       { "replace": "…css…" } }
```

Types: `Overlay` in [`../types/common.ts`](../types/common.ts). Variables are addressed by
`name`, HTTP calls by `callId`, nodes by `id` (or `_elementId`). `belz pd show <input> --find
<text>` prints node ids and key paths. `nodes` runs after `elements.operations` (whose keys refer
to the unedited tree).

- `nodes.update` merges `props` / `field` / `attrs` / `events`; a `null` value deletes the key
  and forces a full save.
- `nodes.insert` generates missing ids deterministically (page, parent and content), so a dry
  run, the first plan and the in-lock re-plan agree. Inserts and removes are full saves.

## Partial or full

`planSave` always builds `patched` first (lossless: only what the overlay touches changes). It
returns a full plan when:

- `fullSaveReason` names the overlay: any add/remove, any `derived.*` edit, `nodes`
  insert/remove or a `null` in `nodes.update`, or a variable/HTTP update on a legacy-format page;
- an op's key is not a verified shape (`isVerifiedKeyShape`): a segment containing a dot inside
  a binding name (`[attr.title]`) is a 500 on the wire, so it is a full save
  (`unverified partial-op key shape: <key>`), and a raw `elements.operations` key of that shape
  is refused as not resolving;
- replaying the ops (`replayOperations`, with the server's key parsing) does not reproduce
  `patched` exactly. This also catches an op whose parent does not exist, which the server
  would accept as a silent no-op.

The wire rules behind this are in [`../api/README.md`](../api/README.md#partial-update-operations),
with evidence in `tests/fixtures/wire/partial-keys.json`.

Tests: `tests/unit/serialize.test.ts`, `nodes-find.test.ts`, `real-pages.test.ts` (lossless full
save of every real page), `wire-evidence.test.ts`. Up: [`../README.md`](../README.md).
