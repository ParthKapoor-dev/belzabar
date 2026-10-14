# Migrations — agent rules

Documentation: [`README.md`](README.md) (package, config, `migrate run` behaviour),
[`lib/README.md`](lib/README.md), [`lib/jenkins/README.md`](lib/jenkins/README.md),
[`commands/README.md`](commands/README.md), [`tests/README.md`](tests/README.md).
Flag reference: each command's `help.txt` / `wi-impl --help-full`.

## Standing instructions

- A change to behaviour, files or error codes updates the README at that level in the same
  commit; a flag change updates `help.txt` and `desc.txt` (`apps/cli/tests/args-docs.test.ts`
  fails on drift).
- Imports: `@belzabar/migrations` from outside the package, relative paths inside it.

## Do not break

- `migrate run` never sends a Jenkins request before `confirmWrite`; `--dry-run` is not exempt,
  because it is still a real build.
- No hard-coded clients, profiles, env names or job names. Clients come from the job's divider
  groups; profile ↔ env only from `jenkins.profileEnvs`; the job only from config.
- A skipped pre-flight must warn (`context.warn`); the caller's active env must be restored.
- Once a build is triggered, every thrown error goes through `withBuildRef` so the caller can
  find the build instead of re-triggering it.
- Jenkins error messages never include response HTML or the crumb; keep the historical
  `MIGRATE_JENKINS_*` codes (callers match on them).
- `migrate` stays in `NOT_ENV_AWARE_NAMESPACES`; `run` keeps `writes: true`.

## Adding a command

1. `commands/<cmd>/index.ts` (default `CommandModule`, exported `args` from core `defineArgs`),
   `help.txt`, `desc.txt`.
2. Register it in `registry.ts`, sorted (`apps/cli/tests/registry.test.ts` checks it).
3. Add its row to `commands/README.md` and the command table in `README.md`.
4. Tests in `tests/unit/` over `fakeFetch`; never against a live Jenkins.
