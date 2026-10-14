# apps/cli/commands

The top-level commands (`wi-impl <cmd>`). Each folder holds `index.ts` (exports `args` and the
default `CommandModule`), `help.txt` (`wi-impl <cmd> --help`) and `desc.txt` (its lines in
`wi-impl --help-full`); the help text is the user reference, this file covers what a maintainer
needs beyond it.

| Path | Command |
|------|---------|
| `registry.ts` | Static, sorted registry of the folders below (help/desc imported as text so the binary embeds them) |
| `cache/` | `wi-impl cache`: invalidate server-side cache entries; `prune-local` for stale local cache files |
| `config/` | `wi-impl config get \| token \| edit` (passthrough: routes its own subcommands; spec in `args.ts`, shared summary in `summary.ts`, also used by `setup`) |
| `envs/` | `wi-impl envs`: list configured environments and the active one |
| `onboard/` | `wi-impl onboard`: guided first run (the credentials step) |
| `setup/` | `wi-impl setup`: write or merge environments into config.json |
| `update/` | `wi-impl update`: fast-forward the source checkout, rebuild, reinstall |

## Behaviour notes

- **cache** self-routes with `defineSubcommands` (default `invalidate`). Invalidation is a remote
  write, so it needs an explicit `--env`; every argument must be a 32-hex or dashed uuid, else
  `INVALID_UUID`, so a mistyped subcommand is never POSTed. `--all --yes` flushes a type
  org-wide. `prune-local` is `writesLocal` and a dry run unless `--yes`: it removes
  pre-env-scope flat cache files (never `method-finder` / `page-finder`, which are flat by
  design) and `.refresh/*.lock` files older than 10 minutes. `pruneLocalCache(dir, opts)` is
  exported for tests.
- **setup** merges into the existing `environments`; `--replace --force` replaces the whole map.
  `--env-file` is parsed with core `parseDotEnv` (inline `# comments` stripped on unquoted
  values); `--from-env` reads `withoutDotenvInjected()`, so values Bun auto-loaded from a cwd
  `.env` are ignored and listed in `meta.warnings`. Interactive setup refuses `--llm`.
- **onboard** returns `failWithData("ONBOARD_INCOMPLETE")` when a step failed (so `install.sh`'s
  `if ! wi-impl onboard` sees it) and re-throws `USER_ABORT` from a step (exit 130).
- **update** (`planUpdate`) only fast-forwards the recorded `install.sourceDir`. With something to
  pull it refuses a dirty tree (`DIRTY_TREE`: tracked or staged changes; untracked files do not
  count) or unpushed commits (`LOCAL_COMMITS`); it never resets. `--force` rebuilds even when up
  to date. The installer gets `--install-dir` / `-InstallDir` from the recorded
  `install.installDir` (`installerCommand`). On Windows, `apps/cli/scripts/install.ps1` stages the new
  binary and `apps/cli/scripts/swap-binary.ps1` swaps it in after the running process exits.

## Adding a top-level command

See [`apps/cli/AGENTS.md`](../AGENTS.md#adding-a-command).

Up: [apps/cli](../README.md).
