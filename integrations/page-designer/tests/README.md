# `tests/`: PD tests

Offline tests for `@belzabar/pd`: parser, serializer, validator and diff units, plus
command-level tests of every read and write path over an in-memory PD server. No network.

```bash
bun test integrations/page-designer      # from the repo root
```

`bunfig.toml` preloads `packages/core/tests/preload-belz-home.ts`, which points `WI_IMPL_HOME` at
a temp dir so caches and lock files never touch `~/.wi-impl`.

## In this directory

| Path | What it is |
|---|---|
| [`unit/`](./unit/README.md) | The test files, their small hand-written fixtures and [`helpers/`](./unit/helpers/README.md) |
| `fixtures/real/` | 15 sanitized real pages and components (`<id>.json`) + `manifest.json`, including duplicate-name pairs and one very large page |
| `fixtures/wire/` | Sanitized live wire evidence for the write contract: `partial-keys.json`, `lock.json`, `revert.json`, `publish.json` |

## Fixtures

- Real pages are refreshed read-only from the repo root with
  `bun scripts/fixtures/capture.ts pd <id,id,…>`, which sanitizes every body.
  `scripts/fixtures/fixtures-secrets.test.ts` fails on anything that looks like a secret.
- Wire evidence was captured on a scratch page with ids, hosts and names replaced. It is pinned
  by `unit/wire-evidence.test.ts`, and `unit/helpers/fake-pd.ts` models the same behaviour; change
  both together if the server's behaviour is re-verified.

## Live write suite (opt-in)

`apps/cli/tests/live/pd-page.live-write.test.ts` saves, locks, publishes without a host and
restores a version on a real scratch page, then puts the original config back, re-publishes and
checks `snapshot --compare`. Only point it at a dedicated scratch page:

```bash
WI_IMPL_LIVE=<env> WI_IMPL_LIVE_WRITE=1 WI_IMPL_LIVE_PD_PAGE=<draftId> bun test apps/cli/tests/live/pd-page.live-write.test.ts
```

Up: [`../README.md`](../README.md).
