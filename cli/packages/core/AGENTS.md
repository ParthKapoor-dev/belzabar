# AGENTS.md — @belzabar/core

## Purpose

`packages/core/` is the **`@belzabar/core`** workspace package — the shared framework consumed
by all CLI modules (`automation-designer/`, `page-designer/`, `migrations/`) and by `cli/` itself.

It provides:
- Config loading and credential management
- Auth (session login, persistence)
- HTTP client (`apiFetch`)
- CLI runners (flat and namespaced)
- Command module interface and result types
- **Unified UI layer** (`src/ui.ts`): clack-backed prompts, lifecycle helpers, spinners,
  and the `HumanUi` implementation that every command's `presentHuman()` consumes. Tables
  are still rendered by `cli-table3`; everything else is `@clack/prompts` + `picocolors`.

---

## Public API

Everything is exported from `src/index.ts`. Grouped by concern:

### Config and Credentials
| Export | Description |
|--------|-------------|
| `Config` | Loads `~/.belz/config.json`; provides `url()`, `user()`, `password()` per env |
| `BELZ_CONFIG_DIR` | Resolved path to `~/.belz/` |

### Auth
| Export | Description |
|--------|-------------|
| `login(env, config)` | Authenticates and returns a session |
| `loadSession(env)` | Loads a saved session from `~/.belz/sessions/<env>.json` |
| `saveSession(env, session)` | Persists a session to disk |
| `AuthSession` | Session type |

### HTTP
| Export | Description |
|--------|-------------|
| `apiFetch(url, options, session)` | Authenticated fetch wrapper; handles `Bearer` and `Raw` auth modes |
| `prepareIpv4Fetch(url, init)` | Pins a request to the host's IPv4 address (preserving `Host` + TLS SNI) |

**Why `prepareIpv4Fetch` exists.** Bun's `fetch` has no happy-eyeballs, so a host that
advertises AAAA over a black-holed v6 path hangs on a SYN that never completes. We resolve
IPv4 ourselves and rewrite the URL to the IP.

That makes the A-record query load-bearing — and an A-only query is exactly what a flaky
upstream resolver tends to `REFUSE`/`ETIMEOUT` while still answering AAAA. So `dns.ts`
resolves via **both** `resolve4()` (c-ares) and `lookup()` (getaddrinfo), retries with
backoff, and caches to `~/.belz/cache/dns.json` — a disk cache, not just an in-memory one,
because the CLI is a short-lived process and an in-memory map would never survive to the
next invocation.

If resolution fails outright, `prepareIpv4Fetch` **returns the original hostname URL rather
than throwing**. Callers have no fallback of their own, and a request that might hang beats a
command that cannot run at all. Do not "simplify" this back into a throw.

### CLI Runners
| Export | Description |
|--------|-------------|
| `runCli(argv, commandMap, options, helpResolver?)` | Flat command runner (no namespaces) |
| `runNamespacedCli(argv, options)` | Namespaced runner — powers the `belz` binary |
| `NamespaceDefinition` | Type for a single namespace (name, description, commands or command, helpDir/helpResolver) |
| `NamespacedCliOptions` | Full config type for `runNamespacedCli` |
| `parseGlobalFlags(argv)` | Pure global-flag parser: `--llm`, `-v/--verbose`, `-e/--env <n>`, `--env=<n>`. Stops at `--`. Duplicate/conflicting `--env` → `INVALID_ARGS` |
| `hasHelpFlag(args)` | `-h`/`--help` anywhere before `--`. The runner shows help for the command instead of executing it (so `config token --help` never runs `token`) |
| `dispatchNamespaced(argv, options)` / `dispatchCommand(...)` | In-process routing: return a `RunOutcome` (`{kind:"envelope", envelope, exitCode}` or `{kind:"print", print, exitCode}`) and **never exit**. `runNamespacedCli` = `installStdioGuard` + `dispatchNamespaced` + `renderOutcome` + `flushAndExit`. Used by `core/testing` |
| `resolveGlobalFlags(argv)` | `parseGlobalFlags` + apply them (output mode, verbose, `Config.setActiveEnv`); no stdio side effects |
| `toEnvelope(...)` | Builds the command envelope; its shape is `EnvelopeSchema` |
| `installStdioGuard()` / `flushStdio()` / `flushAndExit(code)` | Bun drops `console.log` output past the 64 KiB pipe buffer and `process.exit()` discards queued writes. The runner routes console output through queued `stream.write` when not a TTY and awaits every write before exiting. **Never call a bare `process.exit()` after output in runner code — use `flushAndExit`.** |

### Command Interface
| Export | Description |
|--------|-------------|
| `CommandModule` | Interface: `{ parseArgs, execute, presentHuman? }` |
| `ok(data)` | Returns a successful command result |
| `fail(message, details?)` | Returns a failed command result |
| `CliError` | Error class for user-facing failures (caught by runner, rendered cleanly) |

### Envelope contract (`src/envelope.ts`)
`EnvelopeSchema` (zod, strict) is the `--llm` wire contract: `{schema, version, ok, command, data,
error: {code (non-empty), message, details?} | null, meta: {env?, durationMs?, warnings?, …}}`,
with `ok:true ⇔ error:null`. `cli/tests/envelope-contract.test.ts` checks every registered command
against it. Change the schema and the runner together.

### UI (`src/ui.ts`)
| Export | Description |
|--------|-------------|
| `renderHuman(envelope, presenter?)` | Render a command envelope to humans; uses the presenter if given, else a default table/object auto-renderer |
| `renderLLM(envelope)` | Emits a single-line JSON envelope to stdout — byte-stable for agents |
| `HumanPresenterHelpers` | Interface passed to `presentHuman()`: `section/text/success/info/warn/error/step/note/kv/table/object` |
| `lifecycle` | `{ intro, outro, cancel, note, step, spinner }` — scaffolding that no-ops in `--llm` mode |
| `prompts` | `{ confirm, text, password, select, multiselect }` — throws `INTERACTIVE_NOT_SUPPORTED` in `--llm` mode and `NO_TTY` when stdin isn't a TTY |
| `setOutputMode(mode)` / `getOutputMode()` | Module-level mode used by helpers that don't hold a `CommandContext` |
| `colors` | Re-export of `picocolors` for commands that want custom inline styling |

---

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Barrel — re-exports everything |
| `src/config.ts` | `Config` class, `BELZ_CONFIG_DIR`, env var fallback logic |
| `src/auth.ts` | `login`, `loadSession`, `saveSession`, `AuthSession` |
| `src/api.ts` | `apiFetch` — authenticated HTTP with session injection |
| `src/runner.ts` | `runCli`, `runNamespacedCli`, routing, envelope wrapping, help dispatch; also calls `setOutputMode()` after stripping `--llm` |
| `src/command.ts` | `CommandModule`, `CommandContext`, `HumanPresenterHelpers`, `ok`, `fail`, `CliError`, `CommandResult`, `CommandEnvelope` |
| `src/ui.ts` | Unified UI layer: `renderHuman`, `renderLLM`, `HumanUi`, `lifecycle`, `prompts`, `setOutputMode`, `colors` |
| `src/types.ts` | Shared domain types (`Environment`, `AuthSession`, etc.) |
| `src/envelope.ts` | `EnvelopeSchema` — the `--llm` envelope contract |
| `src/testing/` | `@belzabar/core/testing` — test helpers (see Testing below). Never import from runtime code |
| `tests/preload-belz-home.ts` | bun test preload (root + per-dir `bunfig.toml`): `BELZ_HOME` → tmp dir, `BELZ_TEST_TMP` scratch root, removed by a global `afterAll` |

---

## Testing (`@belzabar/core/testing`)

Import from `@belzabar/core/testing` (package export `./testing`). Everything assumes the bun test
preload has pointed `BELZ_HOME` at a tmp dir; helpers refuse to write otherwise.

| Helper | Use |
|--------|-----|
| `fakeFetch(routes).install()` / `.restore()` | Replaces `globalThis.fetch`. Routes: `{"GET /path/*": body}` or `[{method, url: string\|RegExp, response, once?}]`; a response is a JSON value, `Response`, handler `(req) => …`, `respond({status, json\|text\|file, headers})` or `fixture(path)`. String patterns match full URL or path(+query), `*` wildcard. Records `requests` / `calls(method, pattern)`; an unmatched request throws `fakeFetch: no route for …` (and lands in `unmatched`). `install()` also stubs DNS (`setIpv4ResolverForTesting`) so `apiFetch`'s IPv4 pinning runs offline; recorded `url` is the logical URL, `wireUrl` the pinned one |
| `withTempEnvConfig({envs, teamwork?, jenkins?, activeEnv?})` | Writes `config.json` + `sessions/<env>.json` (token default `"test-token"`, `null` = no session → login) under `BELZ_HOME`, calls `reloadConfig()`. `.restore()` puts everything back |
| `runCommand(module, argv, {env?, llm = true, helpResolver?})` | Runs one `CommandModule` through the real dispatch in-process → `{envelope, stdout, stderr, exitCode}`. Global flags parsed as in the binary; `process.exit` is trapped; output mode / active env restored after |
| `runCliInProcess(options, argv, {env?, llm?})` | Same, through full namespace routing (`loadDevCliOptions()` gives the dev entry's maps) |
| `spawnCli(argv, {env, cwd, bin, stdin, timeoutMs})` | Real process: `bun <cli entry>` (or a compiled `bin`) with an isolated env (scratch HOME/cwd, no inherited creds) |
| `repoRoot()` / `cliDir()` / `cliEntry()` / `cliBuildEntry()` | Layout-agnostic paths (`apps/cli` or `cli`) — never hardcode CLI paths in tests |
| `describeLive` / `describeLiveWrite` / `spawnLive` / `registerLiveResource` | Opt-in live suites: run only with `BELZ_LIVE=sems-dev` (+ `BELZ_LIVE_WRITE=1`); any other `BELZ_LIVE` or `--env` is refused. `spawnLive` uses a tmp copy of `~/.belz/config.json` + the sems-dev session (real `~/.belz` is never written). `registerLiveResource` appends to `$BELZ_LIVE_RESOURCES` or `../belzabar-workspace/live-resources.md` if it exists. Write suites: Test-Parth, `belz_tst_` prefix, `afterAll` cleanup |
| `scratchDir(prefix)` | tmp dir under the run's `BELZ_TEST_TMP` (auto-removed) |

Test seams in runtime code (test-only; do not use elsewhere): `reloadConfig()` (config.ts),
`setIpv4ResolverForTesting()` (dns.ts).

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
1. Check all usages across `automation-designer/`, `page-designer/`, `migrations/`, and `cli/`
2. Verify all modules still build after your change (`cd cli && bun run build`)
3. Run all tests (`bun test automation-designer/tests/unit/ migrations/tests/unit/`)

Avoid breaking changes to `CommandModule`, `ok`/`fail`, `CliError`, or the envelope schema —
these are consumed by the MCP adapter (`automation-designer/integrations/gemini-mcp/server.ts`)
and by external `--llm` consumers.

---

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this package — new exports,
changed types, runner behavior changes, or new utilities — update this `AGENTS.md` in the same
commit. Because this package is a shared dependency, always verify all downstream modules build
and all tests pass before committing.
