# Release Module — Maintainer Agent Guide

## Purpose

The `release/` module provides release promotion-tracking commands for the
unified `belz` binary, registered as the `release` namespace. It answers the
question the `agents/release-prep` skill audits by hand: **which change of
which item has reached which environment, and which ticket owns it.**

## Command Routing

```
belz release matrix <release.json>  → release/commands/matrix/
belz release freeze <release-name>  → release/commands/freeze/
```

## How it works

- **matrix** links every ticket to its items with the teamwork linker
  (`extractTicketItems` from `@belzabar/teamwork/lib/items`, the logic behind
  `belz tw items`), then traces every AD item across environments with the AD
  tracer (`traceMethod` from `@belzabar/ad/lib/trace`, behind `belz ad trace`).
  It calls these lib functions, never another command's `execute()`.
  It detects COLLISIONS (an AD item shared by an included and an excluded
  ticket) and, per collision, a LEAK status (has the excluded change reached
  stage). Result is persisted to the ledger (overwriting that release's
  previous audit).
  Everything about the spec is checked **before any network call**
  (`lib/spec.ts`): zod shape (`.strict()`: unknown keys are errors; `excluded`
  defaults to `[]`; `included` non-empty; name must slug to something) (RL-1),
  ticket refs via teamwork's `parseTaskId` and included/excluded overlap
  (TW-6/RL-5), env resolution (RL-2), and the ledger slot (name collision) —
  all `BAD_SPEC` / `LEDGER_NAME_COLLISION`.
  **Env resolution (RL-2):** explicit `spineEnv`/`stageEnv` must be configured;
  missing ones are `<project>-dev` / `<project>-stage`, where project =
  `spec.project`, else the project of an explicit spine/stage env, else the
  active env's (`context.env`: `--env` / BELZ_ENV / defaultEnv). The envelope
  carries `data.project`.
- **freeze** reads a saved matrix record (validated; unreadable →
  `LEDGER_CORRUPT`) and snapshots each item's stage position as the prod
  pointer — prod is not queryable, so it is inferred from stage at
  release-push time. Each item gets `stageStatus` (the stage cell's trace
  status, or `"unknown"` when stage wasn't traced / was a trace error, with a
  warning in `data.warnings` + `meta.warnings`). No items, or no item with
  stage data → `FREEZE_NO_STAGE_DATA`, nothing written (RL-3). An existing
  snapshot is `SNAPSHOT_EXISTS` unless `--force` (RL-4).
- Both commands export `args` (core `defineArgs`) and mark `writesLocal: true`
  (they write only the local ledger, so no explicit `--env` is required).

## Directory Map

```
release/
├── commands/
│   ├── matrix/      belz release matrix — release audit + collision detection
│   └── freeze/      belz release freeze — prod snapshot from stage
├── lib/
│   ├── ledger.ts    JSON store under ~/.belz/promotion/ (atomic writes, LEDGER_CORRUPT,
│   │                releaseSlug → INVALID_RELEASE_NAME, collision + --force guards)
│   └── spec.ts      ReleaseSpecSchema (zod), loadReleaseSpec, resolveReleaseEnvs
├── registry.ts      Static, sorted command registry (@belzabar/release/registry)
├── tests/unit/      bun test — args.test.ts (parsing, BAD_SPEC checks), spec-ledger.test.ts
│                    (RL-1..4; matrix end to end over the real Teamwork fixture via fakeFetch)
├── package.json     @belzabar/release — depends on @belzabar/core, /ad, /teamwork, zod
└── AGENTS.md        This file
```

## Ledger

`~/.belz/promotion/` (files 0644, written tmp + rename via core `writeSecureJson`):
- `releases/<slug>.json`       — a `belz release matrix` result.
- `prod-snapshots/<slug>.json` — a `belz release freeze` snapshot.

`<slug>` = `releaseSlug(name)` (lowercase, runs of other chars → `-`). Two names
with one slug are refused (`LEDGER_NAME_COLLISION`); the stored `name` is the
source of truth.

## Core Behavior Contract

1. Commands export a default `CommandModule` (`schema`, `parseArgs`,
   `execute`, `presentHuman`) and `args` (core `defineArgs`).
2. `release` is in `NOT_ENV_AWARE_NAMESPACES` (`apps/cli/bin/options.ts`): envelopes carry
   no `meta.env`; the envs come from the spec. `--env` only picks the project that
   `matrix` derives spine/stage envs from when the spec names none.
3. Commands never call `process.exit()` or print ad-hoc output.
4. `--llm` mode returns raw JSON envelopes; human mode uses `presentHuman()`.
5. `matrix` traces items SEQUENTIALLY — `traceMethod` mutates the global active
   environment, so concurrent traces would race. Do not parallelize them.

## Known limitations

- AD-only. PD items are listed per ticket but not traced — PD pages are not
  name-resolvable across environments. PD tracing needs caller-supplied
  per-env page IDs; it is deferred (there is no PD trace command yet).
- Leak detection depends on the stage environment being queryable. When the
  AD history service is unavailable on stage, leak status is `unknown`.

## Adding a New Command

1. Create `release/commands/<cmd>/` with `index.ts`, `help.txt`, `desc.txt`.
2. Add it to `registry.ts` (sorted); `apps/cli/tests/registry.test.ts` and
   `apps/cli/tests/args-docs.test.ts` enforce registration and help/desc ↔ spec.
3. Update this file.
