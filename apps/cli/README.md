# apps/cli — the `belz` binary

Package `belzabar.cli`. Builds the `belz` binary: the entry point, the wiring of every
integration's command registry, the top-level commands (`cache`, `config`, `envs`, `onboard`,
`setup`, `update`) and the install scripts. The `ad`, `pd`, `rd`, `tw`, `migrate` and `release`
commands live in `integrations/*`; the framework (runner, args, envelope, http, cache, ui) is
[`@belzabar/core`](../../packages/core/README.md).

## What's here

| Path | Contents |
|------|----------|
| [`bin/`](./bin/README.md) | Entry point, namespace wiring, `--help-full`, build info |
| [`commands/`](./commands/README.md) | Top-level commands and their registry |
| [`lib/`](./lib/README.md) | Releases and self-update: targets, manifest, verified download, background auto-update, swap and rollback |
| [`scripts/`](./scripts/README.md) | Install, reinstall and update helper scripts; the release build |
| [`tests/`](./tests/README.md) | Cross-package CLI tests (registry, args docs, envelope contract, install scripts, live suites) |
| `bunfig.toml` | Test preload (`WI_IMPL_HOME` → tmp) |
| `package.json` | `build` (compile `bin/cli.ts` to `./belz`), `link`; depends on core and every integration |

The compiled binary (`belz`, with `belz.map`) is written here and gitignored.

## Routing

```
belz ad | pd | rd | tw | migrate | release <cmd>  → namespace commands (one registry each)
belz config <sub>                            → passthrough module (routes its own subcommands)
belz cache | envs | onboard | setup | update → top-level commands
belz --version | --help | --help-full        → runner
```

`tw`, `migrate`, `release`, `config`, `envs`, `setup`, `onboard` and `update` are not env-aware:
their envelopes carry no `meta.env` and they run without a selected env.

## Build and install

```bash
bun run belz:build                       # repo root: compile bin/cli.ts into this directory (gitignored binary)
bun apps/cli/bin/cli.ts ad show --help   # dev mode, no compile step
bun run belz:install                     # scripts/install.sh: build, install, first-run setup
bun run belz:reinstall                   # scripts/reinstall.sh: wipe ~/.wi-impl and the binary first
```

The repo-root one-liners (`install.sh`, `install.ps1`) and `belz update` call the scripts in
[`scripts/`](./scripts/README.md).

## Testing

`bun run check` from the repo root (typecheck, docs check, dead-code check, all tests; also CI).
`bun test apps/cli` runs only this package. Live suites are opt-in; see
[`tests/live/`](./tests/live/README.md).

## Configuration

Reads `~/.wi-impl/config.json` and `WI_IMPL_*` variables through core; see the
[root README](../../README.md#configure) and
[`packages/core/src/config/`](../../packages/core/src/config/README.md).

Up: [repo README](../../README.md).
