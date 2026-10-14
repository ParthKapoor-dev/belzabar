# packages/core/tests

Unit tests for `@belzabar/core`. Run with `bun test packages/core` (or `bun run check`).

| File | Covers |
|------|--------|
| `preload-belz-home.ts` | The `bun test` preload used by every package: replaces `WI_IMPL_HOME` with a fresh dir under `WI_IMPL_TEST_TMP` (even when one is exported) and seeds a config with one neutral env `test` |
| `preload-belz-home.test.ts` | The preload overrides an exported `WI_IMPL_HOME`; `core/testing` refuses homes outside `WI_IMPL_TEST_TMP` |
| `args.test.ts` | `defineArgs` values and errors, `defineSubcommands` |
| `config.test.ts` | Schema validation, secrets, atomic 0600 writes, default env, the cwd-`.env` guard |
| `http.test.ts` | Transport timeouts and DNS eviction, `apiFetch` login / 401 retry / headers, error mapping, redaction |
| `runner.test.ts` | Output flushing past the pipe buffer, `parseGlobalFlags`, help handling |
| `runner-envelope.test.ts` | Envelope naming and version, human output, global-flag contract (in-process) |
| `cache.test.ts`, `swr.test.ts`, `finder-index.test.ts` | Env-scoped cache, refresh locks and re-run command, finder index store |
| `confirm.test.ts` | `confirmWrite`, `logWriteIntent` |
| `guards-search.test.ts`, `json-input.test.ts`, `output-fields.test.ts` | Value guards and fuzzy search, JSON input errors, `--fields` |
| `platform-ids.test.ts`, `platform-entities.test.ts`, `platform-entity-cache.test.ts` | `resolveMethodRef` and id guards; the raw-entity not-found rule; evicting another env's entity cache |
| `testing-helpers.test.ts` | `@belzabar/core/testing` itself, including `apiFetch`/login end to end with no network |
| `fixtures/runner-harness.ts` | A tiny CLI with fake commands, spawned by `runner.test.ts` |

Conventions: no module mocks (`scripts/no-module-mocks.test.ts` enforces it); fake the network
with `fakeFetch`; hanging-request tests use a handler that never resolves plus a short
`timeoutMs`.

Up: [package README](../README.md).
