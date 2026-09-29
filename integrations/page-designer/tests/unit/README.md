# `tests/unit/`: PD test files

Every PD test. Pure units run on `fixtures/` here or the real pages in
[`../fixtures/real/`](../README.md#fixtures); command-level tests run the real command modules
through core `runCommand` against the in-memory server in [`helpers/`](./helpers/README.md).

## Suites

| Area | Files |
|---|---|
| Parser | `parser-page`, `parser-nodes`, `parser-variables`, `parser-http` |
| Real pages | `real-pages` (every fixture parses; server-side entity type; lossless full save) |
| Serializer | `serialize` (applyOverlay, raw indices, partial-op coverage, full save), `nodes-find` (`show --find` and node-id ops on the largest real page) |
| Validator | `validator` (existing + invariant rules), `validator-lint` (lint rules, one positive and one negative case each; catalogue ↔ help sync), `validator-real` (0-error calibration, diff-aware gate), `validate-summary` |
| Diff, snapshot | `page-diff`, `snapshot` |
| Read paths | `read-paths` (input resolution, recursive analysis, finder, diff), `show-missing-config`, `draft-guard` (referenceId pairing, translation entity ids) |
| Write paths | `save-publish` (save, publish, preflight), `history-lock` (history ownership and restore, the lock command) |
| Wire contract | `wire-evidence` (key shapes, lock answers, revert form vs `../fixtures/wire/`), `api-errors` (error body summaries) |
| Infrastructure | `args` (defineArgs specs), `cache-env-scope` (page cache and lock file are env-scoped) |

`fixtures/` holds small hand-written node and page JSON (`node-*.json`, `page-minimal.json`)
used by the parser and validator units.

## Writing a test

- A bug fix gets a regression test; prefer a real fixture over a hand-written one.
- Exercise write paths command-level over `startFakePd`, not by mocking `pdApi`.
- A validator change must keep `validator-real.test.ts` at 0 errors.

Up: [`../README.md`](../README.md).
