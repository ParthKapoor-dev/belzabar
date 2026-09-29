# AGENTS.md — CLI (`apps/cli`)

## Purpose

`apps/cli/` (package `belzabar.cli`) builds the **`belz` binary**. It owns:

- the entry point `bin/cli.ts` (the same file runs in dev and is compiled into the release binary),
- the wiring of every integration's static command registry (`bin/options.ts`),
- the top-level commands `cache`, `config`, `envs`, `extension`, `onboard`, `setup`, `update`,
- the install / reinstall scripts.

`ad`, `pd`, `tw`, `migrate` and `release` commands live in the `integrations/*` packages
(`@belzabar/ad`, `@belzabar/pd`, `@belzabar/teamwork`, `@belzabar/migrations`, `@belzabar/release`);
this app only wires them together. The framework (runner, args, envelope, http, cache, ui) is
`@belzabar/core` — see `packages/core/AGENTS.md`.

---

## Directory map

```
apps/cli/
├── bin/
│   ├── cli.ts          Entry: installStdioGuard → load options → runNamespacedCli
│   ├── options.ts      NAMESPACES + registries → runner options; buildHelpFull(); REGISTRIES (tests)
│   └── build-info.ts   Bun macro: {version, sha, dirty, builtAt} for `belz --version`
├── commands/
│   ├── registry.ts     Static, sorted registry of the top-level commands
│   └── cache/ config/ envs/ extension/ onboard/ setup/ update/
│                       each: index.ts (exports `args` + default CommandModule), help.txt, desc.txt
│                       (config keeps its arg spec in config/args.ts)
├── scripts/            install.sh, install.ps1, reinstall.sh, record-install.mjs, swap-binary.ps1
├── tests/              see Tests
├── bunfig.toml         test preload (BELZ_HOME → tmp)
└── package.json        scripts: build, link; depends on core + every integration
```

The compiled binary is written to `apps/cli` as `belz` (gitignored, with `belz.map`).

---

## Routing

`bin/options.ts` builds the `runNamespacedCli` options from the registries:

```
belz ad | pd | tw | migrate | release <cmd>  → namespace commands (one registry each)
belz config | extension <sub>                → passthrough namespaces (the module self-routes)
belz cache | envs | onboard | setup | update → top-level commands
belz --version | --help | --help-full        → runner / entry point
```

- `envAware: false` for the `tw`, `migrate`, `release` namespaces and for
  `config`, `extension`, `envs`, `setup`, `onboard`, `update` — their envelopes carry no `meta.env`.
- `belz onboard` returns `failWithData("ONBOARD_INCOMPLETE")` when any step failed (so `install.sh`'s
  `if ! belz onboard` sees it) and re-throws `USER_ABORT` from a step (CORE-R8).
- `belz cache` self-routes with `defineSubcommands` (default `invalidate`): `belz cache --env <e> <uuid>…`
  (remote write → explicit `--env` required; every uuid must be 32 hex or dashed, else `INVALID_UUID` —
  so a mistyped subcommand is never POSTed (CORE-R12); `--all --yes` for an org-wide flush) and
  `belz cache prune-local [--yes]` (local only, `writesLocal`; dry run unless `--yes`; removes
  pre-env-scope flat cache files — never `method-finder` / `page-finder`, which are flat by
  design — and `.refresh/*.lock` files older than 10 minutes). `pruneLocalCache(dir, opts)` is
  exported for tests.
- `belz --help-full` (`buildHelpFull`) prints every `desc.txt`: namespaces in the fixed
  `NAMESPACES` order, then top-level; commands sorted by `registryNames`. It has no env-, clock-,
  locale- or build-dependent content (`tests/help-full.test.ts` spawns it twice under different
  env/TZ/locale and requires byte-identical output). The runner handles it (`helpFull` option)
  only as the first argument after the global flags (not after a command or `--`); with `--llm`
  it is a `belz.help` envelope with `data.text` (CORE-R11).

---

## Adding a command

- **Top-level:** create `commands/<name>/{index.ts,help.txt,desc.txt}` (declare `args` with
  `defineArgs` / `defineSubcommands`, set `writes` / `writesLocal` / `envAware` as needed) and add
  it to `commands/registry.ts` in sorted order. If it self-routes a namespace like `config`, add
  it to `PASSTHROUGH` in `bin/options.ts`; if it never talks to an env, add it to
  `NOT_ENV_AWARE_TOP_LEVEL`.
- **Integration command:** folder under `integrations/<x>/commands/` + entry in that package's
  `registry.ts` — see its `AGENTS.md`.
- **New namespace:** new integration package (package.json, tsconfig, `registry.ts`), add it to
  `package.json` dependencies here and to `NAMESPACES` + `REGISTRIES` in `bin/options.ts`.

help.txt follows the template in `integrations/automation-designer/AGENTS.md`; desc.txt is one
line per invocation, `belz <…>  :->  <what it does>`. `tests/args-docs.test.ts` fails when either
drifts from the args spec; `tests/registry.test.ts` fails when folders and registries disagree.

---

## Build and install

```bash
bun run belz:build                       # repo root → compiles bin/cli.ts to apps/cli (binary `belz`)
bun apps/cli/bin/cli.ts ad show --help   # dev mode, no compile
bun run belz:install                     # scripts/install.sh
bun run belz:reinstall                   # scripts/reinstall.sh
```

- `scripts/install.sh [--env-file <path>] [--install-dir <dir>]` — `bun install --ignore-scripts`,
  compile, install the binary (default `~/.local/bin`), record install metadata
  (`scripts/record-install.mjs`, read by `belz update`), and on first install run `belz onboard`
  (or `belz setup --env-file`). `scripts/install.ps1` is the Windows equivalent.
- `scripts/reinstall.sh` — wipes `~/.belz/` and the binary, then delegates to `install.sh`.
- The repo-root one-liners (`install.sh`, `install.ps1`) and `belz update` call
  `apps/cli/scripts/`, falling back to the pre-restructure `cli/scripts/` path.

---

## Tests

Run from the repo root: `bun run check` = typecheck + `bun run docs:check` + all tests (also CI:
`.github/workflows/ci.yml`). Files in `tests/`:

| Test | Guards |
|------|--------|
| `registry.test.ts` | every `commands/*/` folder is registered, sorted, has help/desc; all registered commands route |
| `args-docs.test.ts` | help.txt / desc.txt vs each command's `args` spec |
| `args-parse.test.ts`, `args-parse-setup.test.ts` | top-level commands reject bad argv |
| `envelope-contract.test.ts` | every command's help/error `--llm` output vs `EnvelopeSchema` (`KNOWN_VIOLATIONS` must stay justified) |
| `envelope-success.test.ts` | read commands over the sanitized fixtures via fakeFetch return valid `ok:true` envelopes |
| `write-commands.test.ts` | every remote-write command/sub-action declares `writes` (D6) |
| `help-full.test.ts` | `--help-full` is deterministic |
| `help-flags.test.ts` | `--help` anywhere shows help instead of running |
| `compiled-pipe.test.ts` | compiles to a tmp dir; a >64 KiB `--llm` envelope survives a slow pipe |
| `entry.test.ts` | `--version`, registry load-failure report |
| `onboard.test.ts` | a failed step → `ONBOARD_INCOMPLETE` (exit 1); Ctrl-C (`USER_ABORT`) ends the flow |
| `cache-command.test.ts`, `cache-prune-local.test.ts` | `belz cache` invalidate body/guards, prune-local |
| `setup-config-exec.test.ts`, `update-paths.test.ts` | setup merge + password encoding, config token refresh; update script paths |
| `live/` | opt-in: `BELZ_LIVE=sems-dev bun test apps/cli/tests/live` (read-only); add `BELZ_LIVE_WRITE=1` for the AD lifecycle write suite (Test-Parth, `belz_tst_` names, soft-deleted in `afterAll` by `live/support/soft-delete.ts`, published copies included) |

---

## Maintainer Agent Instructions

When you change anything here — commands, entry-point logic, scripts, structure — update this
`AGENTS.md`, the registry, and the command's `help.txt` / `desc.txt` in the same commit.
