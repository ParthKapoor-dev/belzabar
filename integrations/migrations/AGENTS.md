# Migrations (Jenkins-backed) — Maintainer Agent

This module (`@belzabar/migrations`) drives `belz migrate ...` against the team's Jenkins
server (`expertly.db-migration` job). The Jenkins REST client itself lives in
`integrations/jenkins` (`@belzabar/jenkins`); `lib/index.ts` re-exports it.

## Layout

```
migrations/
├── commands/                # Each subdir is a CommandModule (multi-command namespace)
│   ├── profiles/            # List CLIENT/PROFILE_NAME choices grouped by client
│   ├── run/                 # Trigger build, follow console, parse report
│   ├── status/              # Check a build's status by number
│   └── logs/                # Dump (ANSI-stripped) console of a past build
├── registry.ts              # Static, sorted command registry (@belzabar/migrations/registry)
└── lib/
    ├── args.ts              # `migrate run` spec (RUN_ARGS, core defineArgs; unknown flags →
    │                        #   MIGRATE_UNKNOWN_FLAG) + value checks; checks --source/--target-env
    │                        #   against the profile (PROFILE_SEGMENT_TO_ENV / envPairFromProfile)
    ├── resolve-targets.ts   # Pre-flight id resolution on the profile's source env (PD draft →
    │                        #   published swap, AD existence); a skip (source env not configured,
    │                        #   or underivable profile) is a `warn` → meta.warnings, never silent;
    │                        #   non-MIGRATE_* failures (login) get a "fix creds" hint, code kept
    ├── constants.ts         # Default job, client list, env→profile map
    ├── parser.ts            # Strip ANSI, regex-extract migration ids, find REPORT JSON
    ├── profiles.ts          # Discover + cache PROFILE_NAME choices (24 h TTL);
    │                        #   resolveClientForProfile re-fetches once on a miss
    ├── report.ts            # Summarize methodComparisonResult
    ├── artifacts.ts         # Write summary.json + summary.console.log
    ├── types.ts             # All public types
    └── index.ts             # Barrel (also re-exports @belzabar/jenkins)
tests/unit/                  # bun test integrations/migrations/tests (args, profile cache,
                             #   real Jenkins captures, pre-flight + faked end-to-end `run`)
```

## Tests and Fixtures

`tests/fixtures/real/` — sanitized Jenkins captures (host rewritten to
`jenkins.example.com`): job parameters (profiles), build 1904 status, its console
chunk; `manifest.json`. Refresh (read-only) with `bun scripts/fixtures/capture.ts jenkins`.
`tests/unit/real-jenkins.test.ts` replays them through the client via `fakeFetch`.

## `migrate run` contract

- Every run triggers a real Jenkins build. `--dry-run` only sends `DRY_RUN=true`
  to the job; it is not a local validation (help/desc say so).
- `writes: true`, but the namespace is not env-aware: the target comes from the
  profile, guarded by MG-1 (unknown flags) and MG-2 (profile ↔ env checks).
- The pre-flight saves and restores the caller's active env (explicit by name,
  default via `Config.resetActiveEnv()`).

## Conventions

Imports inside the module use relative paths. From outside (the CLI), import
from `migrations/lib` (the barrel).

```ts
import { triggerBuild, parseJenkinsConsole, type MigrateRunData } from "../../migrations/lib";
```

## Configuration

Reads `Config.getJenkins()` from `@belzabar/core`. Configure via
`~/.belz/config.json`:

```json
{
  "jenkins": {
    "baseUrl": "https://jenkins-asg.stg.expertly.cloud",
    "user": "<your jenkins user>",
    "password": "<password or API token>",
    "passwordEncoding": "plain",
    "migrationJob": "Deployments/Expertly/Database/expertly.db-migration"
  }
}
```

Or env vars: `BELZ_JENKINS_URL`, `BELZ_JENKINS_USER`, `BELZ_JENKINS_PASSWORD`,
`BELZ_JENKINS_JOB`. Config file wins.

## Adding a subcommand

1. Add `migrations/commands/<cmd>/index.ts` exporting a default `CommandModule`.
2. Add `help.txt` (full help) and `desc.txt` (one-line description for
   `belz --help-full`).
3. Add it to `registry.ts` (sorted) so the CLI and the compiled binary see it.
