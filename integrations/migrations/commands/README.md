# migrations/commands

One folder per `wi-impl migrate` command, each with `index.ts` (default `CommandModule` plus the
exported `args` spec), `help.txt` (the command's documentation) and `desc.txt` (its
`wi-impl --help-full` lines). Every folder is listed in [`../registry.ts`](../registry.ts).

| Folder | Command | Notes |
|---|---|---|
| `logs/` | `wi-impl migrate logs <n>` | `getFullConsole` + `stripAnsi` |
| `profiles/` | `wi-impl migrate profiles [--refresh] [--client <name>]` | `discoverProfiles`; unknown client → `MIGRATE_INVALID_CLIENT` |
| `run/` | `wi-impl migrate run …` | `writes: true`; confirmation, pre-flight, trigger, follow, report, artifacts |
| `status/` | `wi-impl migrate status <n>` | `getBuild`; human mode tables the build parameters |

`status` and `logs` share their `<build-number>` spec (`buildNumberArgs`, `parseBuildNumber`
in `lib/args.ts`); `run` uses `RUN_ARGS` / `parseMigrateRunArgs` from the same file.

`run/index.ts` also holds `withBuildRef`, which decorates every failure after the trigger with
the build reference (see the package [README](../README.md)).

Commands return `ok(...)` or throw `CliError`; they never print or exit themselves (progress
lines go to stderr as `[migrate] …` in human mode). Adding a command: see [`../AGENTS.md`](../AGENTS.md).
