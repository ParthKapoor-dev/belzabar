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

- **matrix** links every ticket to its items by calling the teamwork linker
  (`integrations/teamwork/commands/items` — `belz tw items`), then traces every
  AD item across environments by calling the AD tracer
  (`integrations/automation-designer/commands/trace` — `belz ad trace`).
  It detects COLLISIONS (an AD item shared by an included and an excluded
  ticket) and, per collision, a LEAK status (has the excluded change reached
  stage). Result is persisted to the ledger.
- **freeze** reads a saved matrix result and snapshots each item's stage
  position as the prod pointer — prod is not queryable, so it is inferred from
  stage at release-push time.

## Directory Map

```
release/
├── commands/
│   ├── matrix/      belz release matrix — release audit + collision detection
│   └── freeze/      belz release freeze — prod snapshot from stage
├── lib/
│   └── ledger.ts    JSON store under ~/.belz/promotion/
└── AGENTS.md        This file
```

## Ledger

`~/.belz/promotion/`:
- `releases/<name>.json`       — a `belz release matrix` result.
- `prod-snapshots/<name>.json` — a `belz release freeze` snapshot.

## Core Behavior Contract

1. Commands export a default `CommandModule` (`schema`, `parseArgs`,
   `execute`, `presentHuman`).
2. Commands never call `process.exit()` or print ad-hoc output.
3. `--llm` mode returns raw JSON envelopes; human mode uses `presentHuman()`.
4. `matrix` traces items SEQUENTIALLY — `ad trace` mutates the global active
   environment, so concurrent traces would race. Do not parallelize them.

## Known limitations

- AD-only. PD items are listed per ticket but not traced — PD pages are not
  name-resolvable across environments. PD tracing needs caller-supplied
  per-env page IDs (see the plan / `belz pd trace`, not yet built).
- Leak detection depends on the stage environment being queryable. When the
  AD history service is unavailable on stage, leak status is `unknown`.

## Adding a New Command

1. Create `release/commands/<cmd>/` with `index.ts`, `help.txt`, `desc.txt`.
2. Run `bun run generate` from `cli/` to regenerate registries.
