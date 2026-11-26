# migrations/tests

Offline tests for `@belzabar/migrations`. Nothing reaches a real Jenkins or platform env:
transport is faked with `fakeFetch` from `@belzabar/core/testing`.

| Directory | Contents |
|---|---|
| [`unit/`](unit/README.md) | `bun test` files |
| `fixtures/real/` | Sanitized Jenkins captures (job parameters; builds 1904 (AD, migrated), 2446 (PD, entity FAILED), 2447 (its PD_MIGRATION_STATUS build), 2789 (AD, background mode), 2848 (AD, batch refused: a called method missing on the target)) with `manifest.json` |

Run from the repo root with `bun test integrations/migrations`, or `bun test` in the package
(`../bunfig.toml` preloads a temporary `WI_IMPL_HOME`, so no real `~/.wi-impl` is touched).

Fixtures are refreshed read-only with `bun scripts/fixtures/capture.ts jenkins` (or `jenkins <n,n>` for named builds) (the capture
env comes from `WI_IMPL_CAPTURE_ENV`); the capture rewrites the Jenkins host to `jenkins.example.com` and
sanitizes every body with `scripts/fixtures/sanitize.ts`.
