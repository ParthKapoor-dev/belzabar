# tests — AD test suites and fixtures

| Path | Contents |
|---|---|
| [`unit/`](unit/README.md) | The `bun test` suites (no network) and their helpers. |
| `fixtures/` | Real captured wire, sanitized. Each directory has a `manifest.json` (file, env, capture time, endpoint, status). |

## Fixtures

| Directory | What it holds |
|---|---|
| `real-v1/`, `real-v2/` | The same 36 real methods, one set per wire version. |
| `definitions/` | V1 automation definitions (`/automations/{id}`), used to resolve step services offline. |
| `categories/`, `services/`, `child-info/` | Category and service listings, callee contracts, db accounts. |
| `callers/` | Method listings and V2 bodies for the reverse index. |
| `draft-published/` | Draft and published V2 bodies of the same methods. |
| `history/`, `cross-env/` | Version history responses; published history bodies of the same logic on two envs. |
| `test-cases/` | A method with a suite: V1/V2 bodies and the suite GET. |
| `export/`, `not-found/` | An export body; the V1 and V2 answers to an unknown uuid. |
| `validate/` | The validator golden body, live case patches (`cases.json`) and online captures. |
| `v1/` | Hand-written single V1 steps for the step parser. Prefer real fixtures. |

Refresh captured fixtures from the repo root with `bun scripts/fixtures/capture.ts <target>`. It
only issues GETs, only talks to the env named by `BELZ_CAPTURE_ENV`, and sanitizes every body;
`scripts/fixtures/fixtures-secrets.test.ts` fails on anything that looks like a secret.

## Live suites

AD's live tests are opt-in and live with the CLI: see
[`apps/cli/tests/live/README.md`](../../../apps/cli/tests/live/README.md). CI never runs them.

Up: [`../README.md`](../README.md)
