# migrations/tests

Offline tests for `@belzabar/migrations`. Nothing reaches a real Jenkins or platform env:
transport is faked with `fakeFetch` from `@belzabar/core/testing`.

| Directory | Contents |
|---|---|
| [`unit/`](unit/README.md) | `bun test` files |
| `fixtures/real/` | Sanitized Jenkins captures (job parameters, one build, one console chunk) with `manifest.json` |

Run from the repo root with `bun test integrations/migrations`, or `bun test` in the package
(`../bunfig.toml` preloads a temporary `WI_IMPL_HOME`, so no real `~/.wi-impl` is touched).

Fixtures are refreshed read-only with `bun scripts/fixtures/capture.ts jenkins` (the capture
env comes from `WI_IMPL_CAPTURE_ENV`); the capture rewrites the Jenkins host to `jenkins.example.com` and
sanitizes every body with `scripts/fixtures/sanitize.ts`.
