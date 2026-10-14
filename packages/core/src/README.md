# packages/core/src

Source of `@belzabar/core`. `index.ts` re-exports every runtime module below;
`platform/` and `testing/` are separate subpath exports.

## What's here

| Path | Role |
|------|------|
| [`args/`](./args/README.md) | `defineArgs` / `defineSubcommands`: declarative argv specs and the parser |
| [`config/`](./config/README.md) | `Config` (active env, credentials), config.json schema, secrets, `WI_IMPL_*` env vars |
| [`http/`](./http/README.md) | The one HTTP stack: transport, sessions/login, `apiFetch`, error mapping, redaction, IPv4 pinning |
| [`output/`](./output/README.md) | `--fields` column selection helpers |
| [`platform/`](./platform/README.md) | `@belzabar/core/platform`: Expertly ids and raw entity GETs |
| [`testing/`](./testing/README.md) | `@belzabar/core/testing`: fakeFetch, temp config, in-process runs, live-suite helpers |
| [`theme/`](./theme/README.md) | Palette, truecolor styling, glyphs, wordmark |
| `index.ts` | Barrel for `@belzabar/core` |
| `runner.ts` | `runNamespacedCli` / `dispatchNamespaced`: global flags, routing, help, env + write guard, envelope, exit |
| `command.ts` | `CommandModule`, `CommandContext`, `CommandEnvelope`, `ok` / `fail` / `failWithData`, `CliError` |
| `registry.ts` | `CommandRegistry` (name → module + help.txt + desc.txt), `registryNames` (sorted), `registryModules`, `registryHelpResolver` |
| `envelope.ts` | `ENVELOPE_VERSION` (`"2.0"`) |
| `ui.ts` | `renderHuman` / `renderLLM`, `lifecycle` (intro/outro/spinner/notice), `prompts`, output mode, `printErr` |
| `confirm.ts` | `confirmWrite` (the one write gate) and `logWriteIntent` (the `[wi-impl <ns> write] {...}` stderr audit line) |
| `cache.ts` | `Cache<T>`: env-scoped JSON file cache with soft/hard TTL; shared lifetimes |
| `swr.ts` | Stale-while-revalidate: refresh locks and the detached `--force` re-run |
| `finder-index.ts` | `finderIndexStore(name)`: the per-env on-disk index behind the AD and PD finders |
| `guards.ts` | Wire-JSON value guards: `isObj`, `asObj`, `str`, `strOrNull`, `num`, `numLike` |
| `search.ts` | Fuzzy scoring for the finders: `scoreText`, `normalizeSearchText`, `tokenize`, `containsWordStart`, `levenshtein`, `dedupeBy` |
| `json-input.ts` | `readJsonInput` / `readJsonInputSync`: user JSON files with the caller's error codes |
| `verbose.ts` | `vlog` / `vtime`: redacted stderr debug lines when `WI_IMPL_VERBOSE=1` (`-v`) |
| `belz-meta.ts` | Install metadata (source checkout, install dir) recorded in config.json and read by `wi-impl update` |
| `open.ts` | `openUrlInBrowser` |
| `types.ts` | `Environment`, `AuthSession`, `ApiOptions` |

## Commands and results

A command module is `{ parseArgs, execute, presentHuman?, envAware?, writes?, requiresEnv?,
writesLocal?, ownsFlags? }`, with its argv spec exported as `args` next to it.

- `ok(data)` — success.
- `fail(code, message, {details?, data?})` — failure.
- `failWithData(code, message, data)` — a failure that still carries its result (validator
  errors, failed preflight, empty lookup): `ok:false`, exit 1, the human presenter still runs,
  then the error is printed.
- `throw new CliError(message, {code?, details?, exitCode?})` — user-facing failure; the runner
  renders it with its `exitCode` (default 1; a cancelled prompt throws `USER_ABORT`, exit 130).

## Runner

`runNamespacedCli(argv, options)` = `installStdioGuard` + `dispatchNamespaced` + `renderOutcome`
+ `flushAndExit`. `dispatchNamespaced` / `dispatchCommand` return a `RunOutcome` and never exit;
`@belzabar/core/testing` drives them in-process.

```
wi-impl <token> [args]
  ├─ token is a namespace  → its commands map, or a passthrough module that self-routes (config)
  ├─ token is a top-level command → dispatch directly
  └─ --help / no args / --help-full / --version → runner output
```

- **Global flags** (`parseGlobalFlags`): `--llm`, `--human`, `-v/--verbose`, `-e/--env <n>`, `--env=<n>`.
  Without `--llm`/`--human` the output mode is `llm` inside an agent session (`inAgentSession`:
  `WI_IMPL_AGENT=1` or `CLAUDECODE=1`), else `human`; both flags → `INVALID_ARGS`. Parsing stops at `--`. Duplicate or conflicting `--env` → `INVALID_ARGS`. A `-v` after the
  command name goes to the command when it declares `--verbose` (or `ownsFlags`); otherwise it
  turns on debug logging.
- **Help.** `-h`/`--help` anywhere before `--` shows the command's help instead of running it
  (`hasHelpFlag`). Help text comes from `registryHelpResolver`, so dev mode and the compiled
  binary print the same thing. Print outcomes are ANSI-stripped off a TTY or under `NO_COLOR`,
  even with `FORCE_COLOR`.
- **`--help-full [<namespace>] [--index]`** is handled only as the first token after the global
  flags; with `--llm` it is a `wi-impl.help` envelope `{data: {text}}`.
- **Unknown commands and flags.** `options.unknownHint()` (the CLI's "newer wi-impl may have it:
  `wi-impl update`" sentence) is appended to `UNKNOWN_COMMAND` / `UNKNOWN_SUBCOMMAND` /
  `UNKNOWN_FLAG` errors, and printed under the human command list.
- **`--version`** prints `options.build` (`{version, sha, dirty, builtAt}`); `wi-impl.version`
  envelope with `--llm`.
- **Env guard.** Without `--env` the default env is used (see [`config/`](./config/README.md)).
  Unknown default → `INVALID_ENV`; no default with several (or zero) envs →
  `ENV_NOT_SELECTED` for env-aware commands (the rest still run). A command with `writes`
  (boolean or `(args) => boolean`) refuses to run without an explicit `--env`
  (`ENV_REQUIRED_FOR_WRITE`) unless a person at a terminal (human mode, TTY stdin and stderr)
  picks the env from a prompt (default preselected; counts as explicit), and prints `→ target env: <name> (<url>)` on stderr in human
  mode. `requiresEnv` is the same guard for a preview that reads the target env (dry runs;
  `details.dryRun: true`). `writesLocal` (local files only) needs no `--env`. Other env-aware
  commands on the default env print `→ env: <name> (<source>; pass --env to choose)`.
  `ctx.envExplicit` says whether `--env` was given.
- **Output flushing.** Bun drops `console.log` output past the 64 KiB pipe buffer, and
  `process.exit()` discards queued writes. Off a TTY the runner queues console output through
  `stream.write` and awaits it before exiting (`flushAndExit`).

## Envelope

`EnvelopeSchema` (`testing/envelope-schema.ts`, strict zod) is the `--llm` wire contract:
`{schema, version, ok, command, data, error, meta}`.

- `schema` is `<namespace>.<command>` from routing (`ad.show`, `wi-impl.envs`); runner-level
  outcomes use `wi-impl.help`, `wi-impl.runner`, `wi-impl.version`. `version` is always `"2.0"`.
- `ok` ⇔ `error: null` ⇔ exit 0.
- `error` is `{code (UPPER_SNAKE), message (no "Error:" prefix), details?}`; `details` is always
  an object (`normalizeDetails`: JSON strings parsed, other strings `{text}`, arrays `{items}`,
  scalars `{value}`; `{stack}` only with `-v`).
- `meta`: `durationMs` always; `env` and `envSource` (`flag` | `WI_IMPL_ENV` | `default`) only for
  env-aware commands with a selected env; `warnings` when raised.

`renderLLM` prints it as one line on stdout. `renderHuman` runs the command's presenter (or a
default table/object renderer) on stdout; errors and `meta.warnings` go to stderr.

## UI

- `lifecycle` — `intro`, `outro`, `cancel`, `note`, `step`, `spinner`, `notice`; all no-op in
  `--llm` mode. `notice(msg)` is for library code without a context (a faint stderr line in
  human mode, only `vlog` in `--llm`). Off a TTY the spinner draws nothing and its final
  message goes to stderr.
- `prompts` — `confirm`, `text`, `password`, `select`, `multiselect`; throw
  `INTERACTIVE_NOT_SUPPORTED` in `--llm` mode and `NO_TTY` without a TTY on stdin.
- `HumanPresenterHelpers` — what `presentHuman` receives:
  `section/text/success/info/warn/error/step/note/kv/table/object`.

## Caches

- `new Cache<T>({dir, ttlMs, staleMs?, envScoped?})` stores `<dir>/<env>/<key>.json`.
  `envScoped` defaults to true because ids collide across envs; opt out only when the key
  encodes the env. `load`, `loadSwr` (`{data, stale, savedAt}`: stale past `staleMs`, null past
  `ttlMs`), `save` (0700 dirs, 0600 files) and `invalidate` (never throws). TTLs may be
  functions of the key.
- Shared lifetimes: `ENTITY_CACHE_STALE_MS` (5 min), `ENTITY_CACHE_TTL_MS` (1 h),
  `FINDER_INDEX_TTL_MS` (7 days).
- SWR: a `.refresh/<key>.lock` (30 s) de-duplicates background refreshes that re-run the current
  invocation with `--force`; side-effect flags such as `--open` are stripped.
- `finderIndexStore(name)` keeps `cache/<name>/index-v1-<env>.json` and rebuilds it on demand.

## Writes

`confirmWrite` is the single write gate: `--yes` proceeds; `--llm` (and, with
`refuseWithoutTty`, a non-TTY) refuses with `<prefix>_CONFIRMATION_REQUIRED`; otherwise it shows
the details and prompts (no → `<prefix>_USER_ABORT`). `logWriteIntent` prints the audit line on stderr.

Up: [package README](../README.md).
