# tests/unit/helpers — shared AD test setup

| File | Contents |
|---|---|
| `fake-ad.ts` | `fakeAdEnv()`: a temp env config (`ENV`, `HOST`), quiet stderr and a `fakeFetch` to install routes on; call `restore()` in `afterEach`. Route builders: `definitionRoute` (V1 automation definitions from `definitions/`), `categoryRoutes`, `historyServiceRoute`, `compiledCacheRoutes`, and `v2Store` (an in-memory method behind GET/POST `/chain/v2`). `FIX` is the fixtures directory. |

```ts
const ad = fakeAdEnv();
afterEach(() => ad.restore());
test("…", async () => {
  ad.install([definitionRoute(), ...compiledCacheRoutes()]);
  await runCommand(cmd, argv, { env: ENV });
  // assert on ad.ff.requests …
});
```

See `save-command.test.ts` and `author-commands.test.ts` for full examples.

Up: [`../README.md`](../README.md)
