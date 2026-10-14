# core/src/testing

`@belzabar/core/testing`: helpers for every package's tests. Test code only; runtime code never
imports it. Everything assumes the bun test preload (`packages/core/tests/preload-belz-home.ts`,
wired by each package's `bunfig.toml`) pointed `WI_IMPL_HOME` at a throwaway dir; the helpers
refuse to write anywhere else (`assertSafeBelzHome`).

## What's here

| File | Helpers |
|------|---------|
| `fake-fetch.ts` | `fakeFetch(routes)`, `respond`, `fixture` |
| `env-config.ts` | `withTempEnvConfig`, `assertSafeBelzHome` |
| `run-command.ts` | `runCommand`, `runCliInProcess` |
| `spawn-cli.ts` | `spawnCli`, `repoRoot`, `cliDir`, `cliEntry`, `cliBuildEntry`, `loadDevCliOptions` |
| `live.ts` | `describeLive`, `describeLiveWrite`, `spawnLive`, `liveCategory`, `liveMethod`, `liveBelzHome`, `registerLiveResource`, `markLiveResourceCleaned`, `LIVE_ENV`, `LIVE_WRITE_PREFIX` |
| `envelope-schema.ts` | `EnvelopeSchema`: the `--llm` wire contract (see [`../README.md`](../README.md#envelope)) |
| `doc-check.ts` | `checkCommandDocs`, `flagsMentioned`: help.txt / desc.txt drift against the args spec |
| `errors.ts` | `errorCode`, `thrownCliError`, `caughtCliError`, `rejectionCode`, `jsonFixtures` |
| `scratch.ts` | `scratchDir(prefix)`: a tmp dir under the run's `WI_IMPL_TEST_TMP`, removed after the run |
| `index.ts` | Re-exports all of the above |

## Helpers

- **`fakeFetch(routes).install()` / `.restore()`** replaces `globalThis.fetch`. Routes are
  `{"GET /path/*": body}` or `[{method, url: string | RegExp, response, once?}]`; a response is
  a JSON value, a `Response`, a handler `(req) => …`, `respond({status, json | text | file,
  headers})` or `fixture(path)`. String patterns match the full URL or path (+ query), with `*`
  wildcards. It records `requests` / `calls(method, pattern)`; an unmatched request throws
  (and lands in `unmatched`). `install()` also stubs DNS so `apiFetch`'s IPv4 pinning runs
  offline; `url` is the logical URL, `wireUrl` the pinned one.
- **`withTempEnvConfig({envs, teamwork?, jenkins?, activeEnv?, defaultEnv?})`** writes
  `config.json` and `sessions/<env>.json` (token `"test-token"` by default; `null` = no session,
  so the command logs in), reloads the config and resets the active env. `.restore()` puts
  everything back.
- **`runCommand(module, argv, {env?, llm = true})`** runs one `CommandModule` through the real
  dispatch in-process → `{envelope, stdout, stderr, exitCode}`. Global flags are parsed as in
  the binary and `process.exit` is trapped. **`runCliInProcess(options, argv)`** does the same
  through full namespace routing (`loadDevCliOptions()` gives the dev entry's options).
- **`spawnCli(argv, {env, cwd, bin, stdin, timeoutMs})`** runs a real process (`bun <entry>` or a
  compiled `bin`) with an isolated env: scratch HOME and cwd, no inherited credentials. Use the
  path helpers instead of hard-coding CLI paths.
- **Errors.** `errorCode(fn)` / `thrownCliError(fn)` / `caughtCliError(promise)` /
  `rejectionCode(promise)` return the `CliError` (or its code) and fail the test on no error or
  a non-`CliError`. `jsonFixtures(dir)` gives a typed sync fixture loader.

## Live suites

Opt-in, against one configured env named by `WI_IMPL_LIVE`. Nothing tenant-specific is
hard-coded:

| Variable | Meaning |
|----------|---------|
| `WI_IMPL_LIVE=<env>` | The env under test (must be in config.json) |
| `WI_IMPL_LIVE_METHOD=<uuid>` | Optional long-lived published method for read smokes |
| `WI_IMPL_LIVE_WRITE=1` | Also run write suites; requires the two below |
| `WI_IMPL_LIVE_CATEGORY` / `WI_IMPL_LIVE_CATEGORY_ID` | The one AD category writes may touch |
| `WI_IMPL_LIVE_RESOURCES` | Ledger file for created objects (default: `live-resources.md` in a sibling maintainer workspace) |
| `WI_IMPL_LIVE_SOURCE_HOME` | Where to copy config and session from (default `~/.wi-impl`) |

`spawnLive` refuses any `--env` other than `WI_IMPL_LIVE` and runs with a tmp `WI_IMPL_HOME` holding a
copy of config.json and that env's session, so the real home is only read. Write suites name
objects with `LIVE_WRITE_PREFIX` (`wi_impl_tst_`), stay in the category, call
`registerLiveResource` for everything they create and clean up in `afterAll`
(`markLiveResourceCleaned` rewrites the ledger row).

Tests: `packages/core/tests/testing-helpers.test.ts`. Up: [src](../README.md).
