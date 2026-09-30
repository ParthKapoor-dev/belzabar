# @belzabar/migrations

`belz migrate …` — list, trigger and inspect builds of a Jenkins migration job that moves
Automation Designer (AD) methods and Page Designer (PD) pages between environments.
Migrations run through Jenkins only; the Jenkins REST client lives in [`lib/jenkins/`](lib/jenkins/README.md).

## Role in the monorepo

- Depends only on `@belzabar/core` (config, http, args, confirmation, platform entity GETs).
- `apps/cli` mounts [`registry.ts`](registry.ts) as the `migrate` namespace.
- `migrate` is **not env-aware** (`NOT_ENV_AWARE_NAMESPACES` in `apps/cli/bin/options.ts`): the
  Jenkins profile names the source and target, so envelopes carry no `meta.env` and `--env` is not needed.

| Directory | Contents |
|---|---|
| [`commands/`](commands/README.md) | One folder per `belz migrate` command |
| [`lib/`](lib/README.md) | Arg specs, profile discovery, pre-flight, console parsing, artifacts, Jenkins client |
| [`tests/`](tests/README.md) | Unit tests over a faked transport and sanitized Jenkins captures |

## Exports

| Export | Resolves to |
|---|---|
| `@belzabar/migrations` | `lib/index.ts` — the lib barrel, including the Jenkins client |
| `@belzabar/migrations/registry` | `registry.ts` — static, sorted command registry |
| `@belzabar/migrations/lib/<file>` | any `lib/*.ts` module |

`scripts/fixtures/capture.ts` uses the barrel (`assertJenkinsAuth`, `buildHeaders`) for its
read-only Jenkins captures.

## Commands

| Command | Kind | What it does |
|---|---|---|
| `belz migrate profiles` | read | Profile choices of the job, grouped by client; cached 24 h |
| `belz migrate run` | **write** | Confirms, triggers a build, follows its console, parses the report |
| `belz migrate status` | read | Build status, result and parameters |
| `belz migrate logs` | read | ANSI-stripped console of a build |

Flags and examples: each command's `help.txt` (`commands/<cmd>/help.txt`) or `belz --help-full`.

## Configuration

`Config.getJenkins()` reads `~/.belz/config.json` → `jenkins`, falling back to trusted
environment variables (the config file wins):

| Key | Env fallback | Notes |
|---|---|---|
| `baseUrl` | `BELZ_JENKINS_URL` | Jenkins root URL |
| `user` | `BELZ_JENKINS_USER` | |
| `password` (+ `passwordEncoding`) | `BELZ_JENKINS_PASSWORD` | API token or password |
| `migrationJob` | `BELZ_JENKINS_JOB` | Required, no default; may be a folder path (`a/b`) |
| `profileEnvs` | — | Optional map of profile segment → belz env, e.g. `{ "devx": "dev" }` |

A missing URL, user, password or job fails `MIGRATE_JENKINS_CONFIG_MISSING`.

Runtime file: `~/.belz/migrations/jenkins-profiles.json` (profile cache).

## Key behaviour of `migrate run`

- **Confirmation.** Every run, `--dry-run` included, is confirmed before any Jenkins request:
  `--yes` proceeds, a terminal is prompted, `--llm` or a non-TTY without `--yes` fails
  `MIGRATE_CONFIRMATION_REQUIRED`.
- **Strict flags.** Unknown flags (`MIGRATE_UNKNOWN_FLAG`, with did-you-mean), bad values
  (`MIGRATE_INVALID_FLAG_VALUE`) and stray positionals (`MIGRATE_UNEXPECTED_ARG`) fail before
  anything runs; so do `--module` + `--module-custom` (`MIGRATE_MODULE_CONFLICT`) and report or
  status modules without `--migration-id` (`MIGRATE_MIGRATION_ID_REQUIRED`).
- **Profiles and envs.** A profile is `<source segment>_<target segment>`. Segments map to belz
  envs only through `jenkins.profileEnvs` (keys case-insensitive); there is no built-in mapping.
  `--source-env`/`--target-env` must agree with the profile (`MIGRATE_ENV_PROFILE_MISMATCH`);
  for an unmapped profile both must be given (`MIGRATE_ENV_PROFILE_UNVERIFIED`). An env pair
  alone derives the profile only when each env maps to exactly one segment
  (`MIGRATE_INVALID_ENV_PAIR`).
- **Clients** are the job's `--- <client> ---` divider groups in the `PROFILE_NAME` choices,
  discovered from Jenkins. An explicit `--client` must be the profile's group
  (`MIGRATE_CLIENT_PROFILE_MISMATCH`); an unlisted profile keeps the explicit client.
- **Pre-flight.** AD and PD ids are resolved on the profile's source env before the trigger:
  missing ids fail (`MIGRATE_TARGET_NOT_FOUND`), a PD draft id is swapped for its published id
  (or fails `MIGRATE_TARGET_DRAFT_UNPUBLISHED`), AD ids must be non-numeric uuids
  (`MIGRATE_TARGET_ID_INVALID`) that come back unchanged (`MIGRATE_TARGET_ID_MISMATCH`). A skipped
  pre-flight is a warning in `meta.warnings`. See [`lib/README.md`](lib/README.md).
- **After the trigger** every failure keeps its code and adds `details.buildTriggered: true`
  plus `jobUrl` / `queueUrl` / `buildNumber` / `buildUrl` when known; unless the build itself
  failed (`MIGRATE_RUN_FAILED`) the message says not to re-run and names `belz migrate status <n>`.
- **Outcome.** A SUCCESS build can migrate nothing: the script skips a method whose version is
  the same on source and target. For a followed, non-dry build of ids `data.outcome` is
  `MIGRATED`, `PARTIAL` or `NOTHING_MIGRATED` (`migrationOutcome` in `lib/report.ts`), each
  unchanged id is a warning, and human output warns instead of reporting success. The run stays
  `ok`; `--strict` fails `MIGRATE_NOTHING_MIGRATED` / `MIGRATE_PARTIALLY_MIGRATED` (without the
  do-not-re-run hint: the build finished).
- `--dry-run` only sends `DRY_RUN=true`: it is still a real Jenkins build.

## Testing

```bash
bun test integrations/migrations      # from the repo root; or `bun test` in this folder
```

`bunfig.toml` preloads a temporary `BELZ_HOME`. See [`tests/README.md`](tests/README.md).
