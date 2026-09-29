# @belzabar/release

`belz release …` — release promotion tracking. It answers the question a release audit
otherwise answers by hand: which change of which Automation Designer (AD) item has reached which
environment, and which ticket owns it.

## Role in the monorepo

- Composes other integrations' libs, never their commands:
  `extractTicketItems` / `parseTaskId` from `@belzabar/teamwork/lib/*` (the logic behind
  `belz tw items`) and `traceMethod` from `@belzabar/ad/lib/trace` (behind `belz ad trace`).
- `apps/cli` mounts [`registry.ts`](registry.ts) as the `release` namespace.
- `release` is **not env-aware** (`NOT_ENV_AWARE_NAMESPACES` in `apps/cli/bin/options.ts`):
  envelopes carry no `meta.env`; the envs come from the spec. `--env` only picks the project
  `matrix` derives envs from when the spec names none.
- Both commands set `writesLocal: true`: they write only the local ledger.

| Directory | Contents |
|---|---|
| [`commands/`](commands/README.md) | `matrix` and `freeze` |
| [`lib/`](lib/README.md) | Release spec validation and the ledger |
| [`tests/`](tests/README.md) | Unit tests with faked Teamwork and AD transport |

Exports: `@belzabar/release/registry` and `@belzabar/release/lib/<file>`.

## Commands

| Command | What it does |
|---|---|
| `belz release matrix <release.json>` | Links tickets to AD items, traces each item across envs, reports collisions and leaks, saves the audit |
| `belz release freeze <release-name> [--force]` | Snapshots each item's stage position from a saved audit as the prod pointer |

Flags and examples: `commands/<cmd>/help.txt` or `belz --help-full`.

## Release spec

```json
{ "name": "2026.10", "included": [123, "…/tasks/456"], "excluded": [789],
  "project": "X", "spineEnv": "x-dev", "stageEnv": "x-stage" }
```

`name` and a non-empty `included` are required; `excluded` defaults to `[]`; unknown keys are
errors. Ticket refs are ids or task URLs. Missing envs are derived from the project; see
[`lib/README.md`](lib/README.md).

## How `matrix` works

1. Validate the whole spec before any request (`BAD_SPEC`, `SPEC_NOT_FOUND`,
   `LEDGER_NAME_COLLISION`).
2. Link every ticket (in parallel). An **excluded** ticket contributes every AD reference it
   mentions, since a missed collision is the dangerous error; an **included** ticket uses the
   latest dev-note block, falling back to every reference when that block lists no AD item.
   `TicketRow.adSource` records which. Linker warnings are passed on as `Ticket #<id>: …`.
3. Trace every unique AD item **sequentially** from the spine env.
4. A **collision** is an AD item referenced by both an included and an excluded ticket. Its
   **leak** status (`classifyLeak`): `leaked` when stage holds the newest spine content, `clean`
   when stage is strictly behind, else `unknown` (trace error, no stage env, other status).
5. If any ticket failed to link, return `RELEASE_MATRIX_INCOMPLETE`
   (`data.collisionsComplete: false`) and write nothing; otherwise save the audit to the ledger,
   replacing that release's previous one.

PD items are listed per ticket but not traced: PD pages are not name-resolvable across envs.

## How `freeze` works

Production is not queryable, so run `freeze` right after the prod push: it reads the saved
`matrix` record (`RELEASE_NOT_FOUND`, `LEDGER_CORRUPT`) and records each item's stage cell as its
prod position. An item without stage data gets `stageStatus: "unknown"` and a warning (in
`data.warnings` and `meta.warnings`). No item with stage data → `FREEZE_NO_STAGE_DATA`, nothing
written. An existing snapshot needs `--force` (`SNAPSHOT_EXISTS`).

## Known limitations

- AD only; PD tracing needs per-env page ids and has no trace command yet.
- Leak detection needs the stage env's AD history; when it is unavailable, leak is `unknown`.

## Testing

```bash
bun test integrations/release      # from the repo root; or `bun test` in this folder
```

See [`tests/README.md`](tests/README.md).
