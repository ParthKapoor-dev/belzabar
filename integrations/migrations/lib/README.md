# migrations/lib

Everything `wi-impl migrate` does besides argument wiring. Exposed as the package root
(`@belzabar/migrations` → `index.ts`) and as `@belzabar/migrations/lib/<file>`.

| File | Contents |
|---|---|
| `args.ts` | `RUN_ARGS` + `parseMigrateRunArgs` (module, ids, profile ↔ env checks, env-pair → profile); `envPairFromProfile`; `normalizeClient` / `matchClient`; `buildNumberArgs` / `parseBuildNumber` for `status` and `logs` |
| `profiles.ts` | `groupProfiles` (divider groups → clients), `discoverProfiles` (24 h cache), `resolveClientForProfile` (one re-fetch on a cache miss) |
| `resolve-targets.ts` | `resolveMigrationTargets` — the pre-flight on the source env |
| `parser.ts` | `stripAnsi` (also Pipeline `ha:////` markers), `parseJenkinsConsole` (migration id, DB/host lines, `REPORT` JSON, failure hints, same-version skips and other `WARNING:` lines via `parseConsoleWarnings`) |
| `report.ts` | `summarizeReport` — counts (incl. `UNCHANGED`) and per-entity rows over `methodComparisonResult` / `comparisonResults`; `migrationOutcome` — MIGRATED / PARTIAL / NOTHING_MIGRATED |
| `artifacts.ts` | `writeArtifacts` — `--out <dir or file.json>` → `<name>.json` + `<name>.console.log` |
| `constants.ts` | `KNOWN_MIGRATE_TYPES`, `JenkinsClient` (a string), profile cache path |
| `types.ts` | Args, data and report shapes |
| `index.ts` | Barrel; also re-exports `jenkins/` |
| [`jenkins/`](jenkins/README.md) | Jenkins REST client |

## Profiles and clients

The job's `PROFILE_NAME` choice parameter is a flat list split by `--- <client> ---` divider
entries. `groupProfiles` turns it into `{ client, profiles }` groups; nothing about clients or
profiles is hard-coded. `discoverProfiles` caches the groups at
`~/.wi-impl/migrations/jenkins-profiles.json` for 24 h (`--refresh` bypasses it); a job without
that parameter fails `MIGRATE_JENKINS_NO_PROFILE_PARAM`.

A profile named `<a>_<b>` maps to a source/target env pair through config
`jenkins.profileEnvs` (`envPairFromProfile`, null when a segment is unmapped).

## Pre-flight (`resolve-targets.ts`)

Runs only for the `PD`, `AD_Method` and `AD_Service` modules with ids; other modules return null.

1. The source env is `--source-env` or the one derived from the profile; if both exist they
   must match. When neither is usable (unmapped profile, or derived env not configured) the
   pre-flight is skipped with a warning, never silently. An explicit but unconfigured env is
   `MIGRATE_SOURCE_ENV_UNKNOWN`.
2. The active env is switched to the source env and restored afterwards
   (`Config.captureActiveEnv`).
3. Each id is fetched with core `fetchRawEntity`:
   - PD page: a `DRAFT` is swapped for its `referenceId` (none → `MIGRATE_TARGET_DRAFT_UNPUBLISHED`).
   - AD method: the id must be a uuid, not all digits (AD also accepts numeric chain ids,
     which would resolve to an unrelated method); the returned `uuid` must match.
   - A 404, an empty body or `null` is `MIGRATE_TARGET_NOT_FOUND`; other non-OK statuses are
     `MIGRATE_TARGET_RESOLVE_FAILED`.
4. A non-`MIGRATE_*` error (login, timeout, network) keeps its code, gains
   `details.preflightEnv`, and says no build was triggered.

## Extending

- A new Jenkins endpoint belongs in [`jenkins/`](jenkins/README.md).
- A new module type: add it to `KNOWN_MIGRATE_TYPES`; if it takes ids that should be checked,
  extend the module patterns in `resolve-targets.ts`.
- Tests live in [`../tests/unit/`](../tests/unit/README.md).
