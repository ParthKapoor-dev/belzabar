# Migrations (Jenkins-backed) — Maintainer Agent

This module drives `belz migrate ...` against the team's Jenkins server
(`expertly.db-migration` job). The legacy `db-migration-tool` service lives in
`migrations-legacy/` and is wired up as `belz migrate-legacy ...`.

## Layout

```
migrations/
├── commands/                # Each subdir is a CommandModule (multi-command namespace)
│   ├── profiles/            # List CLIENT/PROFILE_NAME choices grouped by client
│   ├── run/                 # Trigger build, follow console, parse report
│   ├── status/              # Check a build's status by number
│   └── logs/                # Dump (ANSI-stripped) console of a past build
└── lib/                     # Source-only library (no package.json)
    ├── jenkins/             # HTTP client wrapping the Jenkins REST API
    │   ├── auth.ts          # Basic auth from Config.getJenkins()
    │   ├── crumb.ts         # CSRF crumb fetch + caching
    │   ├── client.ts        # triggerBuild, resolveQueueItem, getBuild, getConsoleChunk
    │   └── stream.ts        # Progressive console tail until build completes
    ├── args.ts              # CLI arg parsing for run/profiles/status/logs
    ├── constants.ts         # Default job, client list, env→profile map
    ├── parser.ts            # Strip ANSI, regex-extract migration ids, find REPORT JSON
    ├── profiles.ts          # Discover + cache PROFILE_NAME choices
    ├── report.ts            # Summarize methodComparisonResult
    ├── artifacts.ts         # Write summary.json + summary.console.log
    ├── types.ts             # All public types
    └── index.ts             # Barrel
```

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
    "password": "<base64-encoded password or API token>",
    "migrationJob": "expertly.db-migration"
  }
}
```

Or env vars: `BELZ_JENKINS_URL`, `BELZ_JENKINS_USER`, `BELZ_JENKINS_PASSWORD`,
`BELZ_JENKINS_JOB`. Config file wins.

## Adding a subcommand

1. Add `migrations/commands/<cmd>/index.ts` exporting a default `CommandModule`.
2. Add `help.txt` (full help) and `desc.txt` (one-line description for
   `belz --help-full`).
3. Run `cd cli && bun run generate` to refresh `registry-migrate.ts` +
   `MigrateHelpMap` so the compiled binary sees it.
