# AGENTS.md — Migrations

## Purpose

The `migrations/` directory is a **source-only library** for the `belz migrate` command. It has
no standalone binary and no `package.json` — it is imported directly by `cli/commands/migrate/`
via a relative path.

All migration logic (argument parsing, API client, WebSocket log streaming, profile discovery,
reporting) lives here. The actual CLI wiring lives in `cli/commands/migrate/index.ts`.

---

## Directory Map

```
migrations/
├── lib/
│   ├── index.ts        Barrel — re-exports all public API for consumers
│   ├── types.ts        Shared TypeScript types (MigrationProfile, RunResult, etc.)
│   ├── args.ts         CLI argument parsing and validation (parses `belz migrate` subcommand args)
│   ├── constants.ts    Static values (environment URLs, default timeouts, etc.)
│   ├── client.ts       HTTP client — migration API calls (list profiles, trigger run, etc.)
│   ├── ws.ts           WebSocket client — streams live migration log output during a run
│   ├── log-parser.ts   Parses structured log lines emitted during migration execution
│   ├── profiles.ts     Profile discovery, filtering, and local cache management
│   ├── artifacts.ts    Pre-migration artifact resolution (what will be affected by the migration)
│   └── report.ts       Final migration report formatting and rendering
└── tests/
    └── unit/
        ├── migrate-args.test.ts        Tests for args.ts
        ├── migrate-command.test.ts     Integration-level tests for the migrate command
        ├── migrate-log-parser.test.ts  Tests for log-parser.ts
        └── migrate-profiles.test.ts    Tests for profiles.ts
```

---

## How Consumers Import

```typescript
// cli/commands/migrate/index.ts
import { ... } from "../../../migrations/lib";
```

Always import from `migrations/lib` (the barrel), not from individual files, unless you need to
import a type that is not re-exported by the barrel.

---

## Running Tests

```bash
# From the repo root
bun test migrations/tests/unit/
```

14 tests total across 4 files.

---

## Extending the Library

When adding new functionality:
1. Add the implementation file to `migrations/lib/`
2. Re-export its public API from `migrations/lib/index.ts`
3. Add corresponding tests in `migrations/tests/unit/`
4. Update this `AGENTS.md`

---

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this module — new lib files,
changed types, new migration phases, changed argument handling, or test additions — update this
`AGENTS.md` in the same commit.
