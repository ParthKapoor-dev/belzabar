# `lib/types/`: PD types

| File | What it holds |
|---|---|
| `common.ts` | The in-memory model: `HydratedPage`, `ParsedNode` (union keyed on `kind`), `PageVariable`, `PageDerivedVariable`, `PageHttpRequest`, `ValidationIssue`, and the `Overlay` edit format. Re-exports the few raw types commands pass through (`RawPageResponse`, `RawHistoryEntry`, `PdStatus`, …). |
| `wire.ts` | Raw API shapes exactly as the server sends them: `RawPageResponse` (stringified `configuration`), `RawConfiguration`, `RawLayoutNode`, list/history/lock/dependency rows, `RawPartialUpdateOperation`. |

## Rules

- Commands import types from `common.ts` only; `wire.ts` is for `lib/` code.
- `raw` is kept on every parsed node, variable and HTTP call and on the page itself, so unknown
  shapes round-trip unchanged.
- `ParsedNode` walkers switch exhaustively on `kind`; a new kind must be handled everywhere the
  compiler points to.
- The validator reads `HydratedPage`; the serializer edits `rawConfiguration`.

Wire behaviour behind these shapes: [`../api/README.md`](../api/README.md). Up:
[`../README.md`](../README.md).
