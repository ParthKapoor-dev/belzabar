# scripts

Repo-level checks and tooling. All run with Bun from the repo root; the `*.test.ts` files run
as part of `bun test`.

| Path | Role |
|------|------|
| `docs-check.ts` | `bun run docs:check`: keeps README.md / AGENTS.md honest (see below) |
| `docs-check.test.ts` | Unit tests for `docs-check.ts` |
| `dead-code.ts` | `bun run dead-code`: TypeScript-compiler-API dead-code report (unused exports split into dead / local-only / test-only, unreferenced files, unused or undeclared dependencies). `--json`, `--summary`, `--check` (exit 1 on any finding outside its `ALLOW` list) |
| `ci-pins.test.ts` | Every workflow (and `cloud/publish.sh`) uses the same pinned Bun and installs from the committed lockfile |
| `no-module-mocks.test.ts` | No test uses `mock.module` (it is process-wide in Bun); fake the network with `fakeFetch` |
| [`fixtures/`](./fixtures/README.md) | Read-only wire-fixture capture, sanitizer and secrets scan |

## docs:check

Over every README.md and AGENTS.md (skipping `node_modules`, `fixtures/` dirs and build output):

1. **Paths.** Code spans, link targets and fenced-block tokens that look like repo paths must
   exist (resolved against the doc's directory, then the repo root); `@belzabar/<pkg>` must be a
   real workspace package. Placeholders (`<uuid>`, `*`, `…`) are skipped.
2. **Commands.** Every `belz <ns> <cmd> [<sub>]` in code must be a registered command (and
   subcommand, where the command declares `defineSubcommands` without a default).

A line containing `docs-check:ignore` is skipped.

`bun run check` = typecheck + docs:check + dead-code + all tests; CI runs the same.

Up: [repo README](../README.md).
