# `tests/unit/helpers/`: shared test helpers

| File | What it gives a test |
|---|---|
| `fake-pd.ts` | `startFakePd(pages)`: an in-memory PD server behind core `fakeFetch` (pages, versions and history, lock, partial and full PUT, publish, revert, name search, page-dependencies), plus `run(cmd, argv)` in its env, `page()`/`cleanInner()` builders and `innerOf()`. Partial PUTs use the fake's own key parser (`applyWireOps`), written from the wire evidence and deliberately independent of belz's serializer. Knobs simulate trouble: `locks` (mine / someone else's), `releaseStatus`, `saveStatus`, `searchStatus`, `onAcquire`, `getOverride` (a lagging read), `onSave` (a server storing something else); `log()` lists every request. |
| `real.ts` | `REAL_FILES` and `loadReal(idOrFile)` over `../../fixtures/real/` |
| `paths.ts` | `getPathForTest(root, key)`: reads a value at a save-pipeline key path |

When the server's behaviour is re-verified live, update `fake-pd.ts` and the evidence in
`../../fixtures/wire/` together. Up: [`../README.md`](../README.md).
