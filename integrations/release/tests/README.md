# release/tests

Offline tests for `@belzabar/release`. Teamwork and AD are faked over the wire with
`fakeFetch` (`@belzabar/core/testing`); the Teamwork captures come from
`integrations/teamwork/tests/fixtures/real/`. There are no fixtures of its own.

| Directory | Contents |
|---|---|
| [`unit/`](unit/README.md) | `bun test` files |

Run from the repo root with `bun test integrations/release`, or `bun test` in the package
(`../bunfig.toml` preloads a temporary `WI_IMPL_HOME`, so the ledger is written there).
