# AGENTS.md — @belzabar/core

## Purpose

`packages/core/` is the **`@belzabar/core`** workspace package — the shared CLI framework used by
every `integrations/*` package and by `apps/cli`. Package exports: `.` → `src/index.ts` (barrel),
`./platform` → `src/platform/index.ts`, and `./testing` → `src/testing/index.ts` (test helpers only; never import from runtime code).

## Module map (`src/`)

| Path | Role |
|------|------|
| `src/args/` | `defineArgs` / `defineSubcommands` (`spec.ts` types, `parse.ts` parser) |
| `src/config/` | `index.ts` (`Config`, env table, default env), `schema.ts` (zod: `environments`, `defaultEnv`, `teamwork` {baseUrl,…}, `jenkins` {…, migrationJob, profileEnvs}, `lint` {resolverTables}, `belz`), `secrets.ts`, `fs.ts` (atomic 0600 writes), `env-vars.ts` (trusted `BELZ_*` vars) |
| `src/http/` | `transport.ts` (`httpRequest`, timeouts, limiter), `auth.ts` (sessions/login), `api.ts` (`apiFetch`), `errors.ts`, `redact.ts`, `dns.ts` (IPv4 pinning) |
| `src/runner.ts` | `runNamespacedCli` / `dispatchNamespaced`: global flags, routing, help, env + write guard, envelope, exit |
| `src/command.ts` | `CommandModule`, `CommandContext`, `ok` / `fail` / `failWithData`, `CliError` |
| `src/envelope.ts` | `EnvelopeSchema` — the `--llm` wire contract |
| `src/registry.ts` | `CommandRegistry` types, `registryNames` (sorted), `registryModules`, `registryHelpResolver` |
| `src/cache.ts` | `Cache<T>` — env-scoped JSON file cache with hard/soft TTL; shared lifetimes `ENTITY_CACHE_STALE_MS` (5 min), `ENTITY_CACHE_TTL_MS` (1 h), `FINDER_INDEX_TTL_MS` (7 days) |
| `src/swr.ts` | Stale-while-revalidate: refresh locks + detached `--force` re-run |
| `src/ui.ts` / `src/theme/` | Human/LLM rendering, `lifecycle`, `prompts`; palette (`theme/tokens.ts`), truecolor styling + glyphs (`theme/terminal.ts`) |
| `src/confirm.ts` | `confirmWrite` (the one write gate: `--yes` / --llm refusal / prompt, per-namespace codes, wording and details shape) and `logWriteIntent` (`[belz <ns> write] {...}` stderr audit line) |
| `src/output/fields.ts` | `--fields a,b\|all`: `parseFieldList` (→ `FieldSelection`, unknown → `INVALID_VALUE`), `projectRow`, `pickFields`, `isEmptyValue` |
| `src/json-input.ts` | `readJsonInput` / `readJsonInputSync(path, {unreadable(err, missing), invalid(err)})` — user JSON files (`--file`, `--spec`, case files, ledgers) with the caller's codes |
| `src/guards.ts` | Wire-JSON value guards: `isObj`, `asObj`, `str` (trimmed or undefined), `strOrNull`, `num` (finite), `numLike` (also numeric strings), `Obj` |
| `src/search.ts` | Fuzzy scoring for the AD/PD finders: `scoreText`, `normalizeSearchText`, `tokenize`, `containsWordStart`, `levenshtein` (also the arg parser's "did you mean"), `dedupeBy` |
| `src/verbose.ts` | `vlog` / `vtime` — redacted stderr debug lines when `BELZ_VERBOSE=1` (`-v`) |
| `src/belz-meta.ts` | Install metadata (source checkout, install dir, binary path) used by `belz update` |
| `src/open.ts` | `openUrlInBrowser` |
| `src/types.ts` | Shared domain types (`Environment`, `AuthSession`, …) |
| `src/platform/` | `@belzabar/core/platform` — Expertly-specific shared code: `ids.ts` (`resolveMethodRef`, `normalizeUuid`, `trimUuidPadding`, `isHex32`, `isEntityId`, `canonicalUuid`), `entities.ts` (`fetchRawChain` / `fetchRawPage` / `fetchRawEntity`: not found = 404 or an empty/`null` 2xx; callers map `onError` / `badJson` to their own codes; `adChainPath`, `pdPagePath`) |
| `src/testing/` | `@belzabar/core/testing` (see Testing) |

---

## Public API

Everything is exported from `src/index.ts`. Grouped by concern:

### Config and Credentials (`src/config/`)
| Export | Description |
|--------|-------------|
| `Config` | Active env + credentials. `setActiveEnv(name)` (explicit, throws `INVALID_ENV`), `resetActiveEnv()`, `activeEnv` (never throws), `defaultEnvName` (BELZ_ENV > config `defaultEnv` > the only configured env > `NO_ENV` = ""), `envSource` (`flag`/`BELZ_ENV`/`config`/`only`/`none`), `noEnvSelectedError()`, `envWasExplicit`, `configError`, `assertUsable()`, `cleanBaseUrl`/`loginId`/`password` (throw `CONFIG_INVALID`/`INVALID_ENV`/`ENV_NOT_SELECTED` when the env is unusable), `getJenkins()`, `getTeamwork()`, `withEnv(name, fn)` (run on another env, restore the caller's selection exactly, even on throw), `captureActiveEnv()` (restore function, for code that switches several times) |
| `BELZ_CONFIG_DIR` / `CONFIG_FILE_PATH` | `~/.belz/` (or `BELZ_HOME`) and its `config.json` |
| `loadConfigFileRaw()` / `writeConfigFile(cfg)` | Raw read (unvalidated, for read-modify-write) / atomic 0600 write |
| `validateConfigFile` | zod schema (passthrough: unknown keys survive). Violations → `CONFIG_INVALID` naming the path |
| `decodeSecret(value, encoding, path)` / `encodeSecret(plain)` / `keepSecret(entry)` | The one secret helper. `passwordEncoding: "plain"\|"base64"`; absent = legacy base64, decoded strictly (bad base64 → `CONFIG_INVALID`). New writes: plain + `"plain"` (file is 0600) — never guess an encoding |
| `writeSecureJson` | tmp + fsync + rename, mode 0600 (config, every session file) |
| `hardenBelzHome(home)` | Runs once when config loads: tightens a pre-existing belz home to 0700 (home, `sessions/`, `cache/`) and 0600 (`config.json`, session files). Never throws; no-op on Windows. `Cache.save` creates 0700 dirs / 0600 files |
| `trustedBelzEnv()` | The env vars belz reads: `BELZ_*` only, minus values injected by a cwd `.env*` (Bun autoloads dotenv even in the compiled binary; 1.2.x has no flag to stop it). Runtime vars: `BELZ_HOME`, `BELZ_ENV`, `BELZ_HTTP_TIMEOUT_MS`, `BELZ_HTTP_WRITE_TIMEOUT_MS`, `BELZ_JENKINS_{URL,USER,PASSWORD,JOB}`, `BELZ_TEAMWORK_{EMAIL,PASSWORD}` (plain). `BELZ_SRC_DIR` (update's fallback source dir) also goes through it. Unprefixed `TEAMWORK_*` keys are only read by `belz setup --from-env`, via `withoutDotenvInjected()` (same dotenv filter for every key; `dropped` lists ignored keys, surfaced as a warning) |

### HTTP (`src/http/`) — the one stack for AD/PD, Teamwork and Jenkins
| Export | Description |
|--------|-------------|
| `apiFetch(path, {authMode?, timeoutMs?, ...RequestInit})` | Expertly client. Resolves with the `Response` (map errors yourself). Bearer/Raw token from the env session; single-flight login; 401 → one shared refresh + one retry (FormData re-sent; streams → `AUTH_EXPIRED`); a second 401 after the re-login → `AUTH_FAILED` (no loop). The refresh is announced via `lifecycle.notice` (silent in `--llm`). `"Expertly-Auth-Token": "true"` header → the session token; no Content-Type on GET |
| `httpRequest(url, {timeoutMs?, pinIpv4?, ...RequestInit})` | The transport. Timeout (to response headers, then the same value as an idle deadline on each body chunk, so a body that stalls mid-read rejects `res.text()`/`json()` with `HTTP_TIMEOUT` `details.phase: "body"` instead of hanging) → `HTTP_TIMEOUT`: default 60 s for GET/HEAD/OPTIONS, **300 s for every other method** (`defaultTimeoutMs(method)`; env `BELZ_HTTP_TIMEOUT_MS` sets both, `BELZ_HTTP_WRITE_TIMEOUT_MS` overrides non-GET; both via `trustedBelzEnv`). Per call `timeoutMs: <ms>`, or `0` / `"none"` for streams and long server-side runs. A timed-out non-GET has `details.mayHaveCompleted: true, retryable: false`, its message says the operation may still complete on the server, and it is **never** retried (not even the pinned-IP hostname retry). Network failure → `HTTP_NETWORK_ERROR` (`details: {method, connectPhase, mayHaveCompleted, retryable}`). A failure on the pinned IP evicts the pin and retries once by hostname **only** when it is a connect-phase failure (`isConnectPhaseError`: refused/unreachable, nothing sent) or the method is a read; a non-GET that failed after connecting (ECONNRESET, socket closed) is never re-sent and has `mayHaveCompleted: true`. Use it for non-Expertly hosts (Teamwork, Jenkins) |
| `login()` / `ensureSession()` / `refreshSession(stale)` / `loadSession()` | Per-env sessions in `sessions/<env>.json` (0600). `/do/login` uses the read timeout (60 s / `BELZ_HTTP_TIMEOUT_MS`), not the write one, and times out with a login-specific `HTTP_TIMEOUT`. Errors: `AUTH_MISSING_CREDENTIALS`, `AUTH_FAILED`, `AUTH_NO_TOKEN` |
| `jwtExpiry(token)` / `isTokenExpired(token, skew?)` | JWT `exp` helpers (`config token` re-logs in on expiry) |
| `httpError(res, opts)` / `expectJson` / `readJsonOrNull` / `expectFound` | Response → CliError: 404 → `NOT_FOUND` (or `notFoundCode`), else `HTTP_<status>` (or `${codePrefix}_<status>`). `expectJson` treats a 2xx with an empty/`null` body as not-found (the AD chain GET does this for unknown uuids) |
| `apiError(res, {code, message?, path?})` / `ensureApiOk` | The integrations' non-OK error: namespace code (string or `(status) => code`, e.g. 409 → `AD_VERSION_CONFLICT`), message (default `<status> <statusText> on <path>`), `details: {path?, status, body: readErrorBody}`. `readJsonOrNull`/`expectJson` take `badJson(text, res)` to replace `HTTP_BAD_JSON` with a namespace error |
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
| `declaresFlag`, `acceptedFlags` | Lets the runner leave command-declared flags (`-v`) alone (the help.txt/desc.txt drift check `checkCommandDocs` is in `@belzabar/core/testing`) |

### CLI Runners
| Export | Description |
|--------|-------------|
| `runNamespacedCli(argv, options)` | Namespaced runner — powers the `belz` binary |
| `NamespaceDefinition` | Type for a single namespace (name, description, commands or command, helpDir/helpResolver) |
| `NamespacedCliOptions` | Full config type for `runNamespacedCli` |
| `parseGlobalFlags(argv)` | Pure global-flag parser: `--llm`, `-v/--verbose`, `-e/--env <n>`, `--env=<n>`. Stops at `--` (everything after it, even `--llm`/`-v`, is the command's). Duplicate/conflicting `--env` → `INVALID_ARGS`. Records each `-v/--verbose` position: a `-v` **after** the command name goes to the command when it declares it (`declaresFlag(module.args, "--verbose")` or `ownsFlags`); otherwise it switches on runner debug logging (`ctx.verbose`) |
| `--help-full` | `options.helpFull({namespace?, index?})` text, only as the first token after the global flags: `--help-full [<namespace>] [--index]` (one section; one line per command); unknown namespace / extra args → `INVALID_ARGS`; `--llm` → `belz.help` envelope `{data: {text}}` |
| Help is plain off a TTY | `renderOutcome` strips ANSI from every print outcome (`--help`, `<ns> --help`, `<cmd> --help`, `--help-full`, `--version`) when the stream is not a TTY or NO_COLOR is set — even under FORCE_COLOR, which agent harnesses export (`stripAnsi`) |
| `--version` | `belz --version` / `--version --llm` (`belz.version` envelope). `options.build` = `{version, sha, dirty, builtAt}` from `apps/cli/bin/build-info.ts`, a Bun macro evaluated at build time |
| Default env | Without `--env`, the runner selects the default env (`Config.resetActiveEnv`: BELZ_ENV > config.json `defaultEnv` > the only configured env). There is no built-in env: an unknown default fails env-aware commands with `INVALID_ENV`, and no default with several (or zero) envs fails them with `ENV_NOT_SELECTED` (listing the configured envs; the envelope then has no `meta.env`). Commands that are not env-aware (`config edit`, `envs`, `setup`, tw/migrate/release) still run; `envs` reports `active: null`. `ctx.envExplicit` says whether `--env` was given. An env-aware command with `writes` (bool or `(args) => bool`) refuses to run without an explicit `--env` → `ENV_REQUIRED_FOR_WRITE`, and in human mode prints `→ target env: <name> (<url>)` on stderr. `requiresEnv` (bool or fn) is the same guard for a *preview* of a write that reads the target env (`ad save/create --dry-run`, `test-case sync` without `--apply`; `details.dryRun: true`, no target-env header). `writesLocal` (local files only) needs no `--env`. Every other env-aware command run on the default env prints `→ env: <name> (<source>; pass --env to choose)` on stderr in human mode, and the envelope carries `meta.envSource` |
| `hasHelpFlag(args)` | `-h`/`--help` anywhere before `--`. The runner shows help for the command instead of executing it (so `config token --help` never runs `token`) |
| `dispatchNamespaced(argv, options)` / `dispatchCommand(...)` | In-process routing: return a `RunOutcome` (`{kind:"envelope", envelope, exitCode}` or `{kind:"print", print, exitCode}`) and **never exit**. `runNamespacedCli` = `installStdioGuard` + `dispatchNamespaced` + `renderOutcome` + `flushAndExit`. Used by `core/testing` |
| `resolveGlobalFlags(argv)` | `parseGlobalFlags` + apply them (output mode, verbose, `Config.setActiveEnv`); no stdio side effects |
| `toEnvelope(...)` | Builds the command envelope; its shape is `EnvelopeSchema` |
| `installStdioGuard()` / `flushStdio()` / `flushAndExit(code)` | Bun drops `console.log` output past the 64 KiB pipe buffer and `process.exit()` discards queued writes. The runner routes console output through queued `stream.write` when not a TTY and awaits every write before exiting. **Never call a bare `process.exit()` after output in runner code — use `flushAndExit`.** |

### Command Interface
| Export | Description |
|--------|-------------|
| `CommandModule` | Interface: `{ parseArgs, execute, presentHuman?, envAware?, writes?, requiresEnv?, writesLocal?, ownsFlags? }`. `schema`/`version` are deprecated and ignored |
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
  tw/migrate/release namespaces, config/envs/setup/onboard/update are not) and never on
  runner-level envelopes, always with `envSource`: `flag` | `BELZ_ENV` | `default` (config.json
  `defaultEnv` or the only configured env); `warnings` when raised.

`apps/cli/tests/envelope-contract.test.ts` (help/error paths of every command) and
`envelope-success.test.ts` (read commands over the real fixtures) check it. Change the schema and
the runner together.

### Cache (`src/cache.ts`, `src/swr.ts`)
| Export | Description |
|--------|-------------|
| `new Cache<T>({dir, ttlMs, staleMs?, envScoped?})` | JSON entries at `<dir>/<env>/<key>.json` (`envScoped` defaults **true** — ids collide across envs; opt out only when the key encodes the env). `save` / `load` / `loadSwr` (→ `{data, stale, savedAt}`, stale past `staleMs`, null past `ttlMs`) / `invalidate` (never throws). TTLs may be functions of the key |
| `normalizeCacheKey` / `currentCacheEnv()` | Safe file stem; the active env name used when none is passed |
| `shouldRefresh` / `triggerDetachedRefresh` / `buildRefreshCommand` | SWR: a `.refresh/<key>.lock` (30 s TTL) de-duplicates background refreshes that re-run the current invocation with `--force` (side-effect flags such as `--open` are stripped) |

Cache roots live under `BELZ_CONFIG_DIR/cache/…` (`~/.belz`, or `BELZ_HOME`). `belz cache prune-local`
removes pre-env-scope flat entries and abandoned refresh locks.

### Stable error codes raised by core
- Args: `UNKNOWN_FLAG`, `MISSING_VALUE`, `INVALID_VALUE`, `MISSING_FLAG`, `MISSING_ARGUMENT`,
  `UNEXPECTED_ARGUMENT`, `CONFLICTING_FLAGS`, `DUPLICATE_FLAG`, `UNKNOWN_SUBCOMMAND`, `MISSING_SUBCOMMAND`.
- Runner: `UNKNOWN_COMMAND`, `INVALID_ARGS` (global flags), `MISSING_ENV_ARG`, `INVALID_ENV`, `ENV_NOT_SELECTED`,
  `ENV_REQUIRED_FOR_WRITE`, `INVALID_COMMAND_MODULE`, `UNHANDLED_EXCEPTION`, `USER_ABORT` (exit 130).
- Config/auth: `CONFIG_INVALID`, `AUTH_MISSING_CREDENTIALS`, `AUTH_FAILED`, `AUTH_NO_TOKEN`, `AUTH_EXPIRED`.
- HTTP: `HTTP_TIMEOUT`, `HTTP_NETWORK_ERROR`, `HTTP_ABORTED`, `HTTP_BAD_JSON`, `NOT_FOUND`, `HTTP_<status>`.
- UI/misc: `INTERACTIVE_NOT_SUPPORTED`, `NO_TTY`, `OPEN_COMMAND_NOT_FOUND`, `OPEN_FAILED`.

Integrations add their own prefixed codes (documented in their `AGENTS.md`). Codes are part of the
public contract: renaming one is a breaking change.

### UI (`src/ui.ts`)
| Export | Description |
|--------|-------------|
| `renderHuman(envelope, presenter?)` | Render a command envelope to humans: presenter (or default table/object renderer) on stdout; on failure the presenter runs only if `data` is set, and the error goes to **stderr**; `meta.warnings` follow on stderr. `ui.warn`/`ui.error` write to stderr |
| `renderLLM(envelope)` | Emits a single-line JSON envelope to stdout — byte-stable for agents |
| `HumanPresenterHelpers` | Interface passed to `presentHuman()`: `section/text/success/info/warn/error/step/note/kv/table/object` |
| `lifecycle` | `{ intro, outro, cancel, note, step, spinner, notice }` — scaffolding that no-ops in `--llm` mode. `notice(msg)` is for library code without a ctx (e.g. the 401 refresh): a faint stderr line in human mode, only `vlog` in `--llm`. When stdout is not a TTY the spinner draws nothing (final `stop`/`error` messages go to stderr as plain lines); colours follow NO_COLOR / FORCE_COLOR / TTY (`src/theme/terminal.ts`) |
| `prompts` | `{ confirm, text, password, select, multiselect }` — throws `INTERACTIVE_NOT_SUPPORTED` in `--llm` mode and `NO_TTY` when stdin isn't a TTY |
| `setOutputMode(mode)` / `getOutputMode()` | Module-level mode used by helpers that don't hold a `CommandContext` |
| `colors` | Re-export of `picocolors` for commands that want custom inline styling |

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
| `repoRoot()` / `cliDir()` / `cliEntry()` / `cliBuildEntry()` / `loadDevCliOptions()` | CLI paths for tests (never hardcode them) and the dev entry's `NamespacedCliOptions` |
| `describeLive` / `describeLiveWrite` / `spawnLive` / `liveCategory` / `liveMethod` / `registerLiveResource` / `markLiveResourceCleaned` | Opt-in live suites against the env named by `BELZ_LIVE` (+ `BELZ_LIVE_WRITE=1`, which requires `BELZ_LIVE_CATEGORY` + `BELZ_LIVE_CATEGORY_ID`; `BELZ_LIVE_METHOD` optional). Nothing tenant-specific is hard-coded. `spawnLive` refuses any other `--env` and uses a tmp copy of `~/.belz/config.json` + that env's session (real `~/.belz` is never written). `registerLiveResource` appends to `$BELZ_LIVE_RESOURCES`, or to the maintainer workspace's live-resources log when that sibling directory exists. `markLiveResourceCleaned(identifier, note)` rewrites that row's cleaned cell in place. Write suites: the `BELZ_LIVE_CATEGORY` only, `belz_tst_` prefix, `afterAll` cleanup |
| `scratchDir(prefix)` | tmp dir under the run's `BELZ_TEST_TMP` (auto-removed) |
| `errorCode(fn)` / `thrownCliError(fn)` / `caughtCliError(p)` / `rejectionCode(p)` | The CliError (or its code) a call throws / a promise rejects with; fail the test on no error or a non-CliError |
| `jsonFixtures(dir, suffix?)` | Sync JSON fixture reader: `const load = jsonFixtures(FIX); load<T>("x.json")` |
| `checkCommandDocs({invocation, def, help, desc})` / `flagsMentioned` | help.txt/desc.txt drift check against the args spec (`src/testing/doc-check.ts`, used by `apps/cli/tests/args-docs.test.ts`) |

The preload (`tests/preload-belz-home.ts`) **always** replaces `BELZ_HOME` with a fresh dir under `BELZ_TEST_TMP`, even when one is exported, and seeds it with a config holding one neutral env `test` (so in-process commands have a default — belz has no built-in env); `assertSafeBelzHome()` (used by `withTempEnvConfig`) refuses any home outside `BELZ_TEST_TMP`.

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
A **passthrough module** has `command: CommandModule` (a single command that routes its own
subcommands — `config`).

Help text comes from a `helpResolver` built from the static registry (`registryHelpResolver`), so
dev mode and the compiled binary print identical help. (`helpDir` still exists on the type but no
namespace uses it.)

---

## Caution: Downstream Impact

Changes to `@belzabar/core` affect every module in the repository. Before changing any public
API:
1. Check all usages across `integrations/*` and `apps/cli/`
2. Run `bun run check` from the repo root (typecheck + docs check + all tests)
3. Build the binary once (`bun run belz:build`) if you touched the runner or stdio

Avoid breaking changes to `CommandModule`, `ok`/`fail`, `CliError`, error codes or the envelope
schema — external `--llm` consumers (agents and scripts) parse them.

---

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this package — new exports,
changed types, runner behavior changes, or new utilities — update this `AGENTS.md` in the same
commit. Because this package is a shared dependency, always verify all downstream modules build
and all tests pass before committing.
