# @belzabar/core

The shared CLI framework behind `wi-impl`: argument parsing, the namespaced runner and its `--llm`
envelope, config and credentials, the HTTP stack, caches, terminal UI, and the test helpers.
Every `integrations/*` package and `apps/cli` build on it; nothing here knows about a specific
command.

## Package exports

| Import | Entry | Use |
|--------|-------|-----|
| `@belzabar/core` | `src/index.ts` | Runtime API (barrel of every `src/*` module) |
| `@belzabar/core/platform` | `src/platform/index.ts` | Expertly entity ids and raw entity GETs shared by AD and PD |
| `@belzabar/core/testing` | `src/testing/index.ts` | Test helpers only; never import it from runtime code |

## What's here

| Path | Contents |
|------|----------|
| [`src/`](./src/README.md) | The framework: runner, command contract, config, http, cache, ui, … |
| [`tests/`](./tests/README.md) | Unit tests for every module, plus the `WI_IMPL_HOME` test preload |
| `bunfig.toml` | `bun test` preload (`tests/preload-belz-home.ts`) |
| `package.json` | Exports above; runtime deps `@clack/prompts`, `cli-table3`, `zod` |

## Key contracts

- **Command contract.** A command is a `CommandModule` (`parseArgs` + `execute` + optional
  `presentHuman`) returning `ok(data)` / `fail(...)` / `failWithData(...)` or throwing `CliError`.
  See [`src/README.md`](./src/README.md).
- **`--llm` envelope.** One JSON object per invocation, shape `EnvelopeSchema`
  (`src/testing/envelope-schema.ts`). Agents and scripts parse it, so it is a public contract.
- **Error codes.** `UPPER_SNAKE` codes are public too; the ones core raises are listed below.
  Integrations add their own prefixed codes.
- **Env selection.** `--env` > `WI_IMPL_ENV` > config.json `defaultEnv` > the only configured env;
  otherwise env-aware commands fail with `ENV_NOT_SELECTED`. Remote writes need an explicit
  `--env` (`ENV_REQUIRED_FOR_WRITE`), except that a person at a terminal picks the env from a
  prompt instead. Details in [`src/config/`](./src/config/README.md) and
  [`src/README.md`](./src/README.md).

### Error codes raised by core

- Args: `UNKNOWN_FLAG`, `MISSING_VALUE`, `INVALID_VALUE`, `MISSING_FLAG`, `MISSING_ARGUMENT`,
  `UNEXPECTED_ARGUMENT`, `CONFLICTING_FLAGS`, `DUPLICATE_FLAG`, `UNKNOWN_SUBCOMMAND`, `MISSING_SUBCOMMAND`.
- Runner: `UNKNOWN_COMMAND`, `INVALID_ARGS` (global flags), `MISSING_ENV_ARG`, `INVALID_ENV`,
  `ENV_NOT_SELECTED`, `ENV_REQUIRED_FOR_WRITE`, `INVALID_COMMAND_MODULE`, `UNHANDLED_EXCEPTION`,
  `USER_ABORT` (exit 130).
- Config/auth: `CONFIG_INVALID`, `AUTH_MISSING_CREDENTIALS`, `AUTH_FAILED`, `AUTH_NO_TOKEN`, `AUTH_EXPIRED`.
- HTTP: `HTTP_TIMEOUT`, `HTTP_NETWORK_ERROR`, `HTTP_ABORTED`, `HTTP_BAD_JSON`, `NOT_FOUND`, `HTTP_<status>`.
- UI: `INTERACTIVE_NOT_SUPPORTED`, `NO_TTY`, `OPEN_COMMAND_NOT_FOUND`, `OPEN_FAILED`.

## Configuration it reads

`~/.wi-impl/config.json` (or `$WI_IMPL_HOME/config.json`) and `WI_IMPL_*` environment variables only;
see [`src/config/README.md`](./src/config/README.md). Runtime files live under the same home:
`sessions/<env>.json`, `cache/…`.

## Testing

`bun test packages/core` (or `bun run check` from the repo root). The preload always points
`WI_IMPL_HOME` at a throwaway dir. Helpers for other packages' tests are in
[`src/testing/`](./src/testing/README.md).

Up: [repo README](../../README.md).
