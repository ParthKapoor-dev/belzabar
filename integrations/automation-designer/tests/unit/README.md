# tests/unit — AD unit and command tests

`bun test` suites with no network. Command suites drive a real command end to end against
`fakeFetch` routes and the real fixtures in [`../fixtures`](../README.md). The root `bunfig.toml`
preload points `WI_IMPL_HOME` at a temp dir, so nothing touches `~/.wi-impl`.

| Area | Files |
|---|---|
| Helpers | `helpers/` ([README](helpers/README.md)), `validate-fixtures.ts` (validator fixtures: `golden()`, `caseBody(name)`, `mutate`, `realV2()`) |
| Args and help | `args-a`, `args-b`, `common-args`, `find-command`, `show-args`, `sql-args`, `sql-explain` |
| API and parsing | `api-error-detection`, `api-http`, `base64`, `fetch-method-hydration`, `fetch-raw`, `parser-v1-method`, `parser-v1-steps`, `parser-v2-loop`, `parser-v2-smoke`, `real-wire`, `parsed-fields-guard`, `stream-parser` |
| Read commands | `categories`, `find-category`, `method-finder`, `callers`, `grep`, `services-methods`, `lookup-views`, `outputs-command`, `show-command`, `show-views`, `show-deleted`, `state-command`, `trim-outputs`, `export-import-childinfo`, `cache-env-scope` |
| History and trace | `diff-history`, `history-restore`, `history-uuid-cache`, `fingerprint`, `trace-envs` |
| Writes | `draft-guard`, `save-command`, `save-structural`, `save-v2-overlay`, `author-commands`, `compact-format`, `create-delete`, `publish-changelog` |
| Validator and lint | `validate-l1`, `validate-rules`, `validate-online`, `validate-team`, `validate-diff`, `validate-command`, `lint` |
| Tests and test cases | `test-expect`, `test-expect-command`, `test-run-commands`, `test-case-list`, `test-case-sync`, `test-suite-wait` |
| SQL | `sql-payload`, `sql-read-only`, `sql-result`, `sql-selector`, `sql-defaults-insert`, `sql-context-prefetch`, `sql-tui-commands` |

(Each name is `<name>.test.ts`.)

## Suites that pin real-data invariants

- `real-wire.test.ts`: fixture inventory and V1↔V2 parse parity.
- `save-v2-overlay.test.ts`: the overlay round trip over the 36 real V2 bodies.
- `validate-diff.test.ts` and `lint.test.ts`: calibration counts over the real bodies. Change
  them only on purpose, with the reason in the commit.

## Writing a test

- Every bug fix gets a regression test.
- Use `@belzabar/core/testing` (`fakeFetch`, `fixture`, `respond`, `withTempEnvConfig`,
  `runCommand`, `caughtCliError`, …) and the AD helpers; never mock modules.
- Prefer real fixtures over hand-written bodies.

Run: `bun test integrations/automation-designer` from the repo root, or `bun run check` for
everything.

Up: [`../README.md`](../README.md)
