# teamwork/tests

Offline tests for `@belzabar/teamwork`. Nothing reaches a real Teamwork site: transport is faked
with `fakeFetch` / `respond` and config with `withTempEnvConfig` (`@belzabar/core/testing`).

| Directory | Contents |
|---|---|
| [`unit/`](unit/README.md) | `bun test` files |
| `fixtures/real/` | Sanitized captures of two tasks and their comment pages, with `manifest.json` |

Run from the repo root with `bun test integrations/teamwork`, or `bun test` in the package
(`../bunfig.toml` preloads a temporary `WI_IMPL_HOME`).

Fixtures are refreshed read-only with `bun scripts/fixtures/capture.ts tw <taskId> [pageSize]`
(a small `pageSize` yields a multi-page capture); bodies are sanitized by
`scripts/fixtures/sanitize.ts`. `@belzabar/release` tests reuse these fixtures.
