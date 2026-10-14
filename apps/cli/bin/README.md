# apps/cli/bin

The `wi-impl` entry point. The same files run in dev (`bun apps/cli/bin/cli.ts …`) and are compiled
into the release binary; commands and help text come from the static registries, so both
modes behave identically.

| File | Contents |
|------|----------|
| `cli.ts` | Entry: `installStdioGuard` → load `options.ts` (a failed import is reported on stderr, exit 70) → internal modes (`WI_IMPL_UPDATE_WORKER=1`: the background update check; `WI_IMPL_RECORD_INSTALL=binary`: the release installer records a binary install; both exit) → `autoUpdateTick` → `runNamespacedCli`. See [`lib/`](../lib/README.md) |
| `options.ts` | `buildCliOptions()`: namespaces (`NAMESPACES`), the `config` passthrough (`PASSTHROUGH`), env-awareness (`NOT_ENV_AWARE_NAMESPACES`, `NOT_ENV_AWARE_TOP_LEVEL`); `buildHelpFull()`; `REGISTRIES` (repo dir → registry, for tests and `scripts/docs-check.ts`) |
| `build-info.ts` | Bun macro `buildInfo()` → `{version, sha, dirty, builtAt}` for `wi-impl --version`, evaluated at build time |

## `--help-full`

`buildHelpFull({namespace?, index?})` prints every command's `desc.txt`: namespaces in the fixed
`NAMESPACES` order, then top-level commands, each sorted by name. `wi-impl --help-full <ns>`
(`ad`, `pd`, `rd`, `tw`, `migrate`, `release`, `top`) prints one section; `--index` prints one line
per command (its first desc line). The output has no env-, clock-, locale- or build-dependent
content, and `apps/cli/tests/help-full.test.ts` requires byte-identical output across runs. The header
tells agents that stdout carries only the envelope and stderr the notices.

Up: [apps/cli](../README.md).
