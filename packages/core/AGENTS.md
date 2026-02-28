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
- Output rendering (display tables, sections, objects)

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

### CLI Runners
| Export | Description |
|--------|-------------|
| `runCli(argv, commandMap, options, helpResolver?)` | Flat command runner (no namespaces) |
| `runNamespacedCli(argv, options)` | Namespaced runner — powers the `belz` binary |
| `NamespaceDefinition` | Type for a single namespace (name, description, commands or command, helpDir/helpResolver) |
| `NamespacedCliOptions` | Full config type for `runNamespacedCli` |

### Command Interface
| Export | Description |
|--------|-------------|
| `CommandModule` | Interface: `{ parseArgs, execute, presentHuman? }` |
| `ok(data)` | Returns a successful command result |
| `fail(message, details?)` | Returns a failed command result |
| `CliError` | Error class for user-facing failures (caught by runner, rendered cleanly) |

### Display
| Export | Description |
|--------|-------------|
| `DisplayManager` | Renders tables, section headers, and objects in human mode |

---

## Key Files

| File | Role |
|------|------|
| `src/index.ts` | Barrel — re-exports everything |
| `src/config.ts` | `Config` class, `BELZ_CONFIG_DIR`, env var fallback logic |
| `src/auth.ts` | `login`, `loadSession`, `saveSession`, `AuthSession` |
| `src/api.ts` | `apiFetch` — authenticated HTTP with session injection |
| `src/runner.ts` | `runCli`, `runNamespacedCli`, routing, envelope wrapping, help dispatch |
| `src/command.ts` | `CommandModule` interface |
| `src/output.ts` | `ok`, `fail`, `CliError`, `CommandResult`, `CommandEnvelope` |
| `src/display.ts` | `DisplayManager` — table/section/object rendering |
| `src/types.ts` | Shared types (`OutputMode`, `CommandError`, `CommandMeta`, etc.) |

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
