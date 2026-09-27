# AGENTS.md — @belzabar/core

## Purpose

`packages/core/` is the **`@belzabar/core`** workspace package — the shared framework consumed
by every integration package (`integrations/*`) and by `apps/cli`.

It provides:
- Config loading and credential management (`src/config/`)
- Auth (session login, persistence) and the HTTP stack (`src/http/`)
- The namespaced CLI runner and static command registries (`src/registry.ts`)
- Command module interface and result types
- **Unified UI layer** (`src/ui.ts`): clack-backed prompts, lifecycle helpers, spinners,
  and the `HumanUi` implementation that every command's `presentHuman()` consumes. Tables
  are still rendered by `cli-table3`; everything else is `@clack/prompts` + `picocolors`.

---

## Public API

Everything is exported from `src/index.ts`. Grouped by concern:

### Config and Credentials (`src/config/`)
| Export | Description |
|--------|-------------|
| `Config` | Active env + credentials. `setActiveEnv(name)` (explicit, throws `INVALID_ENV`), `resetActiveEnv()`, `activeEnv` (never throws), `defaultEnvName` (BELZ_ENV > config `defaultEnv` > `nsm-dev`), `envSource` (`flag`/`BELZ_ENV`/`config`/`builtin`), `envWasExplicit`, `configError`, `assertUsable()`, `cleanBaseUrl`/`loginId`/`password` (throw `CONFIG_INVALID`/`INVALID_ENV` when the env is unusable), `getJenkins()`, `getTeamwork()` |
| `BELZ_CONFIG_DIR` / `CONFIG_FILE_PATH` | `~/.belz/` (or `BELZ_HOME`) and its `config.json` |
| `loadConfigFileRaw()` / `writeConfigFile(cfg)` | Raw read (unvalidated, for read-modify-write) / atomic 0600 write |
| `ConfigFileSchema`, `validateConfigFile` | zod schema (passthrough: unknown keys survive). Violations → `CONFIG_INVALID` naming the path |
| `decodeSecret(value, encoding, path)` / `encodeSecret(plain)` / `keepSecret(entry)` | The one secret helper. `passwordEncoding: "plain"\|"base64"`; absent = legacy base64, decoded strictly (bad base64 → `CONFIG_INVALID`). New writes: plain + `"plain"` (file is 0600) — never guess an encoding |
| `writeFileAtomic` / `writeSecureJson` | tmp + fsync + rename, mode 0600 (config, every session file) |
| `trustedBelzEnv()` | The env vars belz reads: `BELZ_*` only, minus values injected by a cwd `.env*` (Bun autoloads dotenv even in the compiled binary; 1.2.x has no flag to stop it). Runtime vars: `BELZ_HOME`, `BELZ_ENV`, `BELZ_HTTP_TIMEOUT_MS`, `BELZ_HTTP_WRITE_TIMEOUT_MS`, `BELZ_JENKINS_{URL,USER,PASSWORD,JOB}`, `BELZ_TEAMWORK_{EMAIL,PASSWORD}` (plain). Legacy `NSM_*`/`TEAMWORK_*` are only read by `belz setup --from-env` |

### HTTP (`src/http/`) — the one stack for AD/PD, Teamwork and Jenkins
| Export | Description |
|--------|-------------|
| `apiFetch(path, {authMode?, timeoutMs?, ...RequestInit})` | Expertly client. Resolves with the `Response` (map errors yourself). Bearer/Raw token from the env session; single-flight login; 401 → one shared refresh + one retry (FormData re-sent; streams → `AUTH_EXPIRED`); a second 401 after the re-login → `AUTH_FAILED` (no loop). The refresh is announced via `lifecycle.notice` (silent in `--llm`). `"Expertly-Auth-Token": "true"` header → the session token; no Content-Type on GET |
| `httpRequest(url, {timeoutMs?, pinIpv4?, ...RequestInit})` | The transport. Timeout (to response headers) → `HTTP_TIMEOUT`: default 60 s for GET/HEAD/OPTIONS, **300 s for every other method** (`defaultTimeoutMs(method)`; env `BELZ_HTTP_TIMEOUT_MS` sets both, `BELZ_HTTP_WRITE_TIMEOUT_MS` overrides non-GET; both via `trustedBelzEnv`). Per call `timeoutMs: <ms>`, or `0` / `"none"` for streams and long server-side runs. A timed-out non-GET has `details.mayHaveCompleted: true, retryable: false`, its message says the operation may still complete on the server, and it is **never** retried (not even the pinned-IP hostname retry). Network failure → `HTTP_NETWORK_ERROR`; a connect failure on the pinned IP evicts the pin and retries once by hostname. Use it for non-Expertly hosts (Teamwork, Jenkins) |
| `login()` / `ensureSession()` / `refreshSession(stale)` / `loadSession()` / `saveSession()` | Per-env sessions in `sessions/<env>.json` (0600). Errors: `AUTH_MISSING_CREDENTIALS`, `AUTH_FAILED`, `AUTH_NO_TOKEN` |
| `jwtExpiry(token)` / `isTokenExpired(token, skew?)` | JWT `exp` helpers (`config token` re-logs in on expiry) |
| `httpError(res, opts)` / `expectOk` / `expectJson` / `readJsonOrNull` / `expectFound` | Response → CliError: 404 → `NOT_FOUND` (or `notFoundCode`), else `HTTP_<status>` (or `${codePrefix}_<status>`). `expectJson` treats a 2xx with an empty/`null` body as not-found (the AD chain GET does this for unknown uuids) |
| `summarizeBody` / `readBodySummary` / `readErrorBody` | Safe bodies for messages/details: HTML → `HTML page: <title>`, truncated, redacted; `readErrorBody` keeps small JSON structured |
| `redactSecrets(value, {keys?})` / `redactString(s)` | Scrub Authorization / Expertly-Auth-Token / cookies / JWTs / password fields, and secret query/form pairs (`?token=`, `access_token=`, `j_password=`, `apiKey=`/`api_key=`, `client_secret=`, `crumb=` …; `httpError`/`expectJson` redact `path` in messages too). Use on anything logged, cached, or put in `error.details`. `{keys: "headers"}` only drops header-like keys (for business payloads whose `token`/`password` fields are data). `vlog` redacts automatically |
| `singleFlight()` / `createLimiter(n)` / `sleep` / `isReplayableBody` | Building blocks for adapters (Teamwork uses them for login + a 6-request cap) |
| `prepareIpv4Fetch(url, init)` / `evictIpv4Cache(host)` | Pins a request to the host's IPv4 address (preserving `Host` + TLS SNI) |

**Why `prepareIpv4Fetch` exists.** Bun's `fetch` has no happy-eyeballs, so a host that
advertises AAAA over a black-holed v6 path hangs on a SYN that never completes. We resolve
IPv4 ourselves and rewrite the URL to the IP.

That makes the A-record query load-bearing — and an A-only query is exactly what a flaky
upstream resolver tends to `REFUSE`/`ETIMEOUT` while still answering AAAA. So `http/dns.ts`
resolves via **both** `resolve4()` (c-ares) and `lookup()` (getaddrinfo), retries with
backoff, and caches to `~/.belz/cache/dns.json` — a disk cache, not just an in-memory one,
because the CLI is a short-lived process and an in-memory map would never survive to the
next invocation. `httpRequest` evicts a host's pin when the pinned IP refuses a connection.

If resolution fails outright, `prepareIpv4Fetch` **returns the original hostname URL rather
than throwing**. Callers have no fallback of their own, and a request that might hang beats a
command that cannot run at all. Do not "simplify" this back into a throw.

### Argument parsing (`src/args/`)
| Export | Description |
|--------|-------------|
| `defineArgs(spec)` | Declarative positionals + flags (boolean/string/number/enum, repeatable, aliases, exclusive/requireOneOf groups) → typed `parse(argv)`; CliError codes `UNKNOWN_FLAG` (did-you-mean), `MISSING_VALUE`, `INVALID_VALUE`, `MISSING_FLAG`, `MISSING_ARGUMENT`, `UNEXPECTED_ARGUMENT`, `CONFLICTING_FLAGS`, `DUPLICATE_FLAG`. A string value that starts with `-` is `MISSING_VALUE` whose message hints `--flag=<value>` (`details.hint`); UNKNOWN_FLAG mentions `--flag=<value>` / `--`; tokens in messages are truncated (`shownToken`). `DUPLICATE_FLAG` names both values (`details.values`) |
| `defineSubcommands(map, opts)` | argv[0] selects a sub-spec (`UNKNOWN_SUBCOMMAND`, `MISSING_SUBCOMMAND`); optional `default` |
| `checkCommandDocs`, `declaresFlag`, `acceptedFlags` | help.txt/desc.txt drift check; lets the runner leave command-declared flags (`-v`) alone |

### CLI Runners
| Export | Description |
|--------|-------------|
| `runNamespacedCli(argv, options)` | Namespaced runner — powers the `belz` binary |
| `NamespaceDefinition` | Type for a single namespace (name, description, commands or command, helpDir/helpResolver) |
| `NamespacedCliOptions` | Full config type for `runNamespacedCli` |
| `parseGlobalFlags(argv)` | Pure global-flag parser: `--llm`, `-v/--verbose`, `-e/--env <n>`, `--env=<n>`. Stops at `--` (everything after it, even `--llm`/`-v`, is the command's). Duplicate/conflicting `--env` → `INVALID_ARGS`. Records each `-v/--verbose` position: a `-v` **after** the command name goes to the command when it declares it (`declaresFlag(module.args, "--verbose")` or `ownsFlags`); otherwise it switches on runner debug logging (`ctx.verbose`) |
| `--version` | `belz --version` / `--version --llm` (`belz.version` envelope). `options.build` = `{version, sha, dirty, builtAt}` from `apps/cli/bin/build-info.ts`, a Bun macro evaluated at build time |
| Default env (D6) | Without `--env`, the runner selects the default env (`Config.resetActiveEnv`: BELZ_ENV > config.json `defaultEnv` > nsm-dev); an unknown default fails env-aware commands with `INVALID_ENV`. `ctx.envExplicit` says whether `--env` was given. An env-aware command with `writes` (bool or `(args) => bool`) refuses to run without an explicit `--env` → `ENV_REQUIRED_FOR_WRITE`, and in human mode prints `→ target env: <name> (<url>)` on stderr. `writesLocal` (local files only) needs no `--env` |
| `hasHelpFlag(args)` | `-h`/`--help` anywhere before `--`. The runner shows help for the command instead of executing it (so `config token --help` never runs `token`) |
| `dispatchNamespaced(argv, options)` / `dispatchCommand(...)` | In-process routing: return a `RunOutcome` (`{kind:"envelope", envelope, exitCode}` or `{kind:"print", print, exitCode}`) and **never exit**. `runNamespacedCli` = `installStdioGuard` + `dispatchNamespaced` + `renderOutcome` + `flushAndExit`. Used by `core/testing` |
| `resolveGlobalFlags(argv)` | `parseGlobalFlags` + apply them (output mode, verbose, `Config.setActiveEnv`); no stdio side effects |
| `toEnvelope(...)` | Builds the command envelope; its shape is `EnvelopeSchema` |
| `installStdioGuard()` / `flushStdio()` / `flushAndExit(code)` | Bun drops `console.log` output past the 64 KiB pipe buffer and `process.exit()` discards queued writes. The runner routes console output through queued `stream.write` when not a TTY and awaits every write before exiting. **Never call a bare `process.exit()` after output in runner code — use `flushAndExit`.** |

### Command Interface
| Export | Description |
|--------|-------------|
| `CommandModule` | Interface: `{ parseArgs, execute, presentHuman?, envAware?, writes?, writesLocal?, ownsFlags? }`. `schema`/`version` are deprecated and ignored |
| `ok(data)` | Returns a successful command result |
| `fail(code, message, {details?, data?})` | Returns a failed command result |
| `failWithData(code, message, data)` | Failure that still carries its result (validator found errors, preflight failed, lookup found nothing): `ok:false`, exit 1, `data` set; the human presenter still runs, then the error is printed |
| `CliError` | Error class for user-facing failures (caught by runner, rendered cleanly) |

### Envelope contract (`src/envelope.ts`)
`EnvelopeSchema` (zod, strict) is the `--llm` wire contract (a public contract — agents parse it):

- `schema`: `<namespace>.<command>`, derived by the runner from routing (`ad.show`, `migrate.status`,
  `release.matrix`, top-level `belz.envs`/`belz.config`); runner-level `belz.help`, `belz.runner`,
  `belz.version`. A command's own `schema` field is ignored.
- `version`: always `"2.0"` (`ENVELOPE_VERSION`).
- `ok`: `true ⇔ error:null ⇔ exit 0`; failure-shaped results use `failWithData`.
- `error`: `{code (UPPER_SNAKE), message (no "Error:" prefix), details?}`; `details` is always an
  object (`normalizeDetails`: JSON-object strings parsed, other strings → `{text}`, arrays →
  `{items}`, scalars → `{value}`; stack as `{stack}` only with `-v`). Exit code = `CliError.exitCode`
  (USER_ABORT → 130).
- `meta`: `durationMs` always; `env` only for env-aware commands (`envAware` defaults true;
  tw/migrate/release namespaces, config/extension/envs/setup/onboard/update are not) and never on
  runner-level envelopes; `warnings` when raised.

`apps/cli/tests/envelope-contract.test.ts` (help/error paths of every command) and
`envelope-success.test.ts` (read commands over the real fixtures) check it. Change the schema and
the runner together.

### UI (`src/ui.ts`)
| Export | Description |
|--------|-------------|
| `renderHuman(envelope, presenter?)` | Render a command envelope to humans: presenter (or default table/object renderer) on stdout; on failure the presenter runs only if `data` is set, and the error goes to **stderr**; `meta.warnings` follow on stderr. `ui.warn`/`ui.error` write to stderr |
| `renderLLM(envelope)` | Emits a single-line JSON envelope to stdout — byte-stable for agents |
| `HumanPresenterHelpers` | Interface passed to `presentHuman()`: `section/text/success/info/warn/error/step/note/kv/table/object` |
| `lifecycle` | `{ intro, outro, cancel, note, step, spinner, notice }` — scaffolding that no-ops in `--llm` mode. `notice(msg)` is for library code without a ctx (e.g. the 401 refresh): a faint stderr line in human mode, only `vlog` in `--llm`. When stdout is not a TTY the spinner draws nothing (final `stop`/`error` messages go to stderr as plain lines); colours follow NO_COLOR / FORCE_COLOR / TTY (`@belzabar/design/terminal`) |
| `prompts` | `{ confirm, text, password, select, multiselect }` — throws `INTERACTIVE_NOT_SUPPORTED` in `--llm` mode and `NO_TTY` when stdin isn't a TTY |
| `setOutputMode(mode)` / `getOutputMode()` | Module-level mode used by helpers that don't hold a `CommandContext` |
| `colors` | Re-export of `picocolors` for commands that want custom inline styling |

---

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Barrel — re-exports everything |
| `src/config/` | `index.ts` (`Config`, env table, default env), `schema.ts` (zod), `secrets.ts` (encode/decode), `fs.ts` (atomic 0600 writes), `env-vars.ts` (trusted `BELZ_*` vars, dotenv guard) |
| `src/http/` | `transport.ts` (timeout, pin eviction, singleFlight, limiter), `auth.ts` (sessions, login), `api.ts` (`apiFetch`), `errors.ts` (status → CliError, body summaries), `redact.ts`, `dns.ts` (IPv4 pinning) |
| `src/runner.ts` | `runNamespacedCli`, routing, envelope wrapping, help dispatch; also calls `setOutputMode()` after stripping `--llm` |
| `src/command.ts` | `CommandModule`, `CommandContext`, `HumanPresenterHelpers`, `ok`, `fail`, `CliError`, `CommandResult`, `CommandEnvelope` |
| `src/ui.ts` | Unified UI layer: `renderHuman`, `renderLLM`, `HumanUi`, `lifecycle`, `prompts`, `setOutputMode`, `colors` |
| `src/types.ts` | Shared domain types (`Environment`, `AuthSession`, etc.) |
| `src/envelope.ts` | `EnvelopeSchema` — the `--llm` envelope contract |
| `src/registry.ts` | `CommandRegistry` / `RegisteredCommand` types, `registryModules`, `registryHelpResolver`, `registryNames` |
| `src/testing/` | `@belzabar/core/testing` — test helpers (see Testing below). Never import from runtime code |
| `tests/preload-belz-home.ts` | bun test preload (root + per-dir `bunfig.toml`): `BELZ_HOME` → tmp dir, `BELZ_TEST_TMP` scratch root, removed by a global `afterAll` |

---

## Testing (`@belzabar/core/testing`)

Import from `@belzabar/core/testing` (package export `./testing`). Everything assumes the bun test
preload has pointed `BELZ_HOME` at a tmp dir; helpers refuse to write otherwise.

| Helper | Use |
|--------|-----|
| `fakeFetch(routes).install()` / `.restore()` | Replaces `globalThis.fetch`. Routes: `{"GET /path/*": body}` or `[{method, url: string\|RegExp, response, once?}]`; a response is a JSON value, `Response`, handler `(req) => …`, `respond({status, json\|text\|file, headers})` or `fixture(path)`. String patterns match full URL or path(+query), `*` wildcard. Records `requests` / `calls(method, pattern)`; an unmatched request throws `fakeFetch: no route for …` (and lands in `unmatched`). `install()` also stubs DNS (`setIpv4ResolverForTesting`) so `apiFetch`'s IPv4 pinning runs offline; recorded `url` is the logical URL, `wireUrl` the pinned one |
| `withTempEnvConfig({envs, teamwork?, jenkins?, activeEnv?, defaultEnv?})` | Writes `config.json` + `sessions/<env>.json` (token default `"test-token"`, `null` = no session → login; password base64 unless `passwordEncoding: "plain"`) under `BELZ_HOME`, calls `reloadConfig()` and resets the active env to the default. `.restore()` puts everything back |
| `runCommand(module, argv, {env?, llm = true, helpResolver?})` | Runs one `CommandModule` through the real dispatch in-process → `{envelope, stdout, stderr, exitCode}`. Global flags parsed as in the binary; `process.exit` is trapped; output mode / active env restored after |
| `runCliInProcess(options, argv, {env?, llm?})` | Same, through full namespace routing (`loadDevCliOptions()` gives the dev entry's maps) |
| `spawnCli(argv, {env, cwd, bin, stdin, timeoutMs})` | Real process: `bun <cli entry>` (or a compiled `bin`) with an isolated env (scratch HOME/cwd, no inherited creds) |
| `repoRoot()` / `cliDir()` / `cliEntry()` / `cliBuildEntry()` | Layout-agnostic paths (`apps/cli` or `cli`) — never hardcode CLI paths in tests |
| `describeLive` / `describeLiveWrite` / `spawnLive` / `registerLiveResource` | Opt-in live suites: run only with `BELZ_LIVE=sems-dev` (+ `BELZ_LIVE_WRITE=1`); any other `BELZ_LIVE` or `--env` is refused. `spawnLive` uses a tmp copy of `~/.belz/config.json` + the sems-dev session (real `~/.belz` is never written). `registerLiveResource` appends to `$BELZ_LIVE_RESOURCES` or `../belzabar-workspace/live-resources.md` if it exists. Write suites: Test-Parth, `belz_tst_` prefix, `afterAll` cleanup |
| `scratchDir(prefix)` | tmp dir under the run's `BELZ_TEST_TMP` (auto-removed) |

Test seams in runtime code (test-only; do not use elsewhere): `reloadConfig()` (config/index.ts),
`setIpv4ResolverForTesting()` (http/dns.ts). Hanging-request tests: a fakeFetch handler that
never resolves plus `httpRequest(url, {timeoutMs: 30})` — the timeout is raced, so it fires even
when the fetch ignores the abort signal.

---

## Runner Architecture

`runNamespacedCli` implements the `belz` routing model:

```
belz <token> [args]
  ├─ token matches a namespace → dispatch to namespace commands (or passthrough command)
  ├─ token matches a top-level command → dispatch directly
  └─ token = --help (or no args) → print unified help
```

A **namespace** has `commands: Record<string, CommandModule>` (multiple subcommands).
A **passthrough module** has `command: CommandModule` (single command that handles its own subcommand routing internally — used for `migrate`).

Help resolution: each namespace/module can provide either a `helpDir` (file-based, dev mode) or
a `helpResolver` (function-based, prod mode with embedded text). Both are optional.

---

## Caution: Downstream Impact

Changes to `@belzabar/core` affect every module in the repository. Before changing any public
API:
1. Check all usages across `integrations/*` and `apps/cli/`
2. Verify everything still typechecks and builds (`bun run typecheck`, `bun run belz:build`)
3. Run all tests (`bun run test` from the repo root)

Avoid breaking changes to `CommandModule`, `ok`/`fail`, `CliError`, or the envelope schema —
these are consumed by the MCP adapter (`automation-designer/integrations/gemini-mcp/server.ts`)
and by external `--llm` consumers.

---

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this package — new exports,
changed types, runner behavior changes, or new utilities — update this `AGENTS.md` in the same
commit. Because this package is a shared dependency, always verify all downstream modules build
and all tests pass before committing.
