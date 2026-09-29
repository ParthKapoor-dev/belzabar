# Migrations (`@belzabar/migrations`) — Maintainer Guide

`belz migrate …` drives the team's Jenkins migration job (default
`Deployments/Expertly/Database/expertly.db-migration`, core `DEFAULT_JENKINS_JOB`). The Jenkins
REST client lives in `integrations/jenkins` (`@belzabar/jenkins`); `lib/index.ts` re-exports it.

## Commands

| Invocation | Kind | Notes |
|---|---|---|
| `belz migrate profiles [--refresh] [--client <name>]` | read | PROFILE_NAME choices by client, cached 24 h |
| `belz migrate run --profile <p> --module <type> --ids <csv>` | **write** | triggers a real Jenkins build, follows its console, parses the REPORT |
| `belz migrate status <n>` | read | build status, result, parameters |
| `belz migrate logs <n>` | read | ANSI-stripped console of a build |

`migrate run` flags (see `commands/run/help.txt`): `--module`/`--module-name`, `--module-custom`,
`--client`, `--profile`, `--source-env`/`--target-env` (derive the profile from an NCDNS env pair),
`--ids`/`--ids-file` (exclusive), `--migration-id`, `--async Y|N`, `--migrate-dependents Y|N`,
`--devops-tag`, `--out <dir>`, `--dry-run`, `--no-auto-approve`, `--quiet`, `--no-follow`, `--yes`/`-y`.

## Layout

```
migrations/
├── commands/{logs,profiles,run,status}/{index.ts,help.txt,desc.txt}
├── lib/
│   ├── args.ts             RUN_ARGS (defineArgs, MG-1) + value checks; PROFILE_SEGMENT_TO_ENV /
│   │                       envPairFromProfile — profile ↔ env consistency (MG-2)
│   ├── resolve-targets.ts  pre-flight: resolve ids on the profile's SOURCE env (PD draft →
│   │                       published sibling, AD existence + name)
│   ├── profiles.ts         discoverProfiles (24 h cache, ~/.belz/migrations/jenkins-profiles.json);
│   │                       resolveClientForProfile re-fetches once on a miss (MG-4)
│   ├── parser.ts           stripAnsi, parseJenkinsConsole (migration ids, REPORT JSON)
│   ├── report.ts           summarizeReport (methodComparisonResult)
│   ├── artifacts.ts        writeArtifacts → summary.json + summary.console.log (`--out`)
│   ├── constants.ts        JENKINS_CLIENTS, KNOWN_MIGRATE_TYPES, ENV_TO_PROFILE_SEGMENT, cache path
│   ├── types.ts
│   └── index.ts            barrel (package `.` export; also re-exports @belzabar/jenkins)
├── registry.ts             static, sorted registry (`@belzabar/migrations/registry`)
└── tests/                  unit/*.test.ts, fixtures/real/
```

Package exports: `./registry`, `.` (the lib barrel), `./lib/*`. From outside, import
`@belzabar/migrations` (never a relative path); inside, use relative paths.

## Contracts

- **Not env-aware.** `migrate` is in `NOT_ENV_AWARE_NAMESPACES` (`apps/cli/bin/options.ts`):
  the Jenkins target comes from the profile, so envelopes carry no `meta.env` and the runner's
  explicit-`--env` rule for `writes` does not apply. `migrate run` still declares `writes: true`.
- **What guards `run` instead:**
  - MG-1 — strict parsing: unknown flags `MIGRATE_UNKNOWN_FLAG` (with did-you-mean), bad values
    `MIGRATE_INVALID_FLAG_VALUE`, stray positionals `MIGRATE_UNEXPECTED_ARG`; plus
    `MIGRATE_MODULE_REQUIRED`, `MIGRATE_IDS_REQUIRED`, `MIGRATE_IDS_CONFLICT`, …
  - MG-2 — `--source-env`/`--target-env` must match the profile's segments
    (`MIGRATE_ENV_PROFILE_MISMATCH`); for an unknown profile family both must be given
    explicitly (`MIGRATE_ENV_PROFILE_UNVERIFIED`).
  - Confirmation — every `run` (including `--dry-run`) is confirmed before any Jenkins
    request: `--yes`/`-y` proceeds, a TTY is prompted, `--llm` or a non-TTY without `--yes`
    fails `MIGRATE_CONFIRMATION_REQUIRED` (details: profile, client, module, resolved ids, dry run).
  - Pre-flight — ids are resolved on the source env before the build: missing ids fail
    (`MIGRATE_TARGET_NOT_FOUND`, `MIGRATE_TARGET_DRAFT_UNPUBLISHED`); a PD draft id is swapped
    for its published id. A skipped pre-flight (source env not configured, or underivable)
    is a warning in `meta.warnings`, never silent. The caller's active env is restored after.
    AD ids must be uuids, not all digits (`MIGRATE_TARGET_ID_INVALID`; AD also accepts
    numeric chain ids, OTH-R27); a 200 with an empty/`null` body is `MIGRATE_TARGET_NOT_FOUND`
    (OTH-R22); a method whose `uuid` differs from the input is `MIGRATE_TARGET_ID_MISMATCH`.
    Only an unparseable body counts as not found: a stalled body read keeps core's
    `HTTP_TIMEOUT` (with `details.preflightEnv`, "retry" hint) — no build is triggered.
  - Flags (OTH-R25/R26): `--module` + `--module-custom` → `MIGRATE_MODULE_CONFLICT`;
    `*_COMPARISON_REPORT`/`*_MIGRATION_STATUS` without `--migration-id` →
    `MIGRATE_MIGRATION_ID_REQUIRED`; an explicit `--client` that isn't the profile's Jenkins
    group → `MIGRATE_CLIENT_PROFILE_MISMATCH` (an unlisted profile keeps the explicit client).
  - After the trigger (OTH-R23): every failure (queue, getBuild, console stream, timeout,
    artifacts, the build's own failure) keeps its code and gets `details.buildTriggered: true`,
    `jobUrl`, and `queueUrl` / `buildNumber` / `buildUrl` when known; except for
    `MIGRATE_RUN_FAILED` the message says "do NOT re-run" and names `belz migrate status <n>`
    (`withBuildRef` in `commands/run/index.ts`). A 2xx trigger with no queue Location is
    treated the same.
- `--dry-run` only sends `DRY_RUN=true` to the job: it is still a real Jenkins build, not a
  local validation.
- **Config.** `Config.getJenkins()` from `~/.belz/config.json` → `jenkins` (`baseUrl`, `user`,
  `password` + `passwordEncoding`, `migrationJob`), falling back to trusted `BELZ_JENKINS_URL`,
  `BELZ_JENKINS_USER`, `BELZ_JENKINS_PASSWORD`, `BELZ_JENKINS_JOB`. The config file wins.
  Missing → `MIGRATE_JENKINS_CONFIG_MISSING`.
- Jenkins errors keep their `MIGRATE_JENKINS_*` codes (see `integrations/jenkins/AGENTS.md`).

## Adding a command

1. `commands/<cmd>/index.ts` exporting a default `CommandModule` and `args` (core
   `defineArgs`), plus `help.txt` and `desc.txt`.
2. Add it to `registry.ts` (sorted); `apps/cli/tests/registry.test.ts` and
   `apps/cli/tests/args-docs.test.ts` enforce registration and help/desc ↔ spec.
3. Update this file.

## Testing

- `tests/fixtures/real/` — sanitized Jenkins captures (host rewritten to `jenkins.example.com`):
  job parameters, build 1904 status and console chunk, `manifest.json`. Refresh read-only with
  `bun scripts/fixtures/capture.ts jenkins`.
- `tests/unit/real-jenkins.test.ts` replays them through the client via `fakeFetch`
  (`@belzabar/core/testing`); `preflight.test.ts` covers the pre-flight and a faked end-to-end
  `run`; `run-args.test.ts` (MG-1/MG-2); `profiles-cache.test.ts` (TTL, MG-4);
  `run-safety.test.ts` (OTH-R22/R23/R25/R26/R27). `bunfig.toml` preloads a temp `BELZ_HOME`.
