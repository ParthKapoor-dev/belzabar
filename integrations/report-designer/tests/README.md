# report-designer/tests

Offline tests for `@belzabar/rd`: nothing reaches a real server. Transport is faked with
`fakeFetch` and config with `withTempEnvConfig` (`@belzabar/core/testing`).

| Directory | Contents |
|---|---|
| [`unit/`](unit/README.md) | `bun test` files and the fake RD server |

Run from the repo root with `bun test integrations/report-designer`, or `bun test` in the
package (`../bunfig.toml` preloads a temporary `WI_IMPL_HOME`).
