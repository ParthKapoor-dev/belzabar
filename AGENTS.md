# AGENTS.md — Belzabar Repository

## You Are the Maintainer Agent

You are working inside the **Belzabar** monorepo. Your role is to understand, extend, and
maintain this codebase. Before making changes in any module, read that module's `AGENTS.md`.

**Standing instruction:** Whenever you make a meaningful change to any module — new commands,
changed behavior, new files, API changes, structural reorganization — you **must** update the
`AGENTS.md` in that module. If the overall repository structure changes, update this root
`AGENTS.md` as well. If you add, remove, or change flags on any command, update that command's
`desc.txt` — this is what `belz --help-full` outputs and what runtime agents use as their
command reference.

---

## What Is Belzabar

Belzabar is an internal developer toolset for working with two systems:

- **Automation Designer (AD)** — a backend automation chain system
- **Page Designer (PD)** — a frontend page/component configuration system

It ships two products:

1. **`belz` CLI** — a unified command-line tool for interacting with AD and PD environments
2. **Browser extension** — a content script that enhances the AD/PD web UIs

---

## Repository Layout

| Directory | Package | Role | AGENTS.md |
|-----------|---------|------|-----------|
| `apps/cli/` | `belzabar.cli` | Builds the `belz` binary: entry point, top-level commands, install scripts | `apps/cli/AGENTS.md` |
| `apps/extension/` | `belzabar-extension` | Browser extension (MV3, JavaScript) | `apps/extension/AGENTS.md` |
| `packages/core/` | `@belzabar/core` | Shared CLI framework (runner, config, auth, api, cache, ui, testing) | `packages/core/AGENTS.md` |
| `packages/design/` | `@belzabar/design` | Design tokens shared by the CLI and the extension | — |
| `integrations/automation-designer/` | `@belzabar/ad` | `belz ad` commands + lib | `integrations/automation-designer/AGENTS.md` |
| `integrations/page-designer/` | `@belzabar/pd` | `belz pd` commands + lib | `integrations/page-designer/AGENTS.md` |
| `integrations/teamwork/` | `@belzabar/teamwork` | `belz tw` commands + lib | `integrations/teamwork/AGENTS.md` |
| `integrations/migrations/` | `@belzabar/migrations` | `belz migrate` commands + lib (Jenkins-backed) | `integrations/migrations/AGENTS.md` |
| `integrations/release/` | `@belzabar/release` | `belz release` commands (uses AD/TW libs) | `integrations/release/AGENTS.md` |
| `integrations/jenkins/` | `@belzabar/jenkins` | Jenkins REST client used by migrations | `integrations/jenkins/AGENTS.md` |
| `scripts/fixtures/` | — | Read-only wire-fixture capture + sanitizer | — |
| `cloud/` | — | Claude Code cloud-session bootstrap (publish + sandbox files) | `cloud/README.md` |

---

## Monorepo Structure

This is a **Bun workspaces** monorepo (no Turborepo). Root `package.json` workspaces:
`packages/*`, `apps/*`, `integrations/*`. Every workspace has its own `package.json` and a
`tsconfig.json` extending the root `tsconfig.base.json`.

- Integrations depend on `@belzabar/core` (and on each other through package imports, e.g.
  `@belzabar/release` → `@belzabar/ad/lib/trace`); never through `../../..` paths.
- Integration packages export `./registry` (their static command registry) and `./lib/*`.
- `apps/cli` depends on every integration and wires their registries together.

Root scripts: `bun run test`, `bun run typecheck` (one `tsc` program over all workspaces),
`bun run check`, `bun run build` (`bun run --filter '*' build`), `bun run belz:build`,
`bun run belz:install`, `bun run belz:reinstall`.

---

## How `belz` Routes Commands

```
belz ad <cmd>      → integrations/automation-designer/commands/<cmd>/
belz pd <cmd>      → integrations/page-designer/commands/<cmd>/
belz tw <cmd>      → integrations/teamwork/commands/<cmd>/
belz migrate <cmd> → integrations/migrations/commands/<cmd>/
belz release <cmd> → integrations/release/commands/<cmd>/
belz config        → apps/cli/commands/config/
belz extension     → apps/cli/commands/extension/
belz cache | envs | setup | onboard | update → apps/cli/commands/<cmd>/
```

Each integration lists its commands in a hand-maintained, sorted `registry.ts` (top-level
commands: `apps/cli/commands/registry.ts`). `apps/cli/bin/options.ts` turns the registries into
the runner options and `belz --help-full`; `apps/cli/bin/cli.ts` is the single entry point (dev
and compiled). Routing itself is `packages/core/src/runner.ts` (`runNamespacedCli`).

**Environments:** `nsm-dev`, `nsm-qa`, `nsm-uat` (pass `--env <name>`, default: `nsm-dev`).

---

## Runtime Data

Everything lives under `~/.belz/`:

| Path | Contents |
|------|----------|
| `~/.belz/config.json` | Optional credentials (config file wins over env vars) |
| `~/.belz/sessions/<env>.json` | Saved auth sessions per environment |
| `~/.belz/cache/methods/<env>/<uuid>.json` | Method cache (5-min soft / 1-h hard TTL) |
| `~/.belz/cache/definitions/<env>/<id>.json` | Automation definition cache |
| `~/.belz/cache/pages/<env>/<id>.json` | PD page/component cache |

Core `Cache` namespaces every entry by env by default (`envScoped: false` opts out).
`BELZ_HOME` overrides `~/.belz` (tests set it via the `bunfig.toml` preload).

---

## Build and Install

```bash
# Install / update the belz binary (from repo root)
bun run belz:install                   # or: bash ./apps/cli/scripts/install.sh

# Clean wipe + fresh install
bun run belz:reinstall                 # or: bash ./apps/cli/scripts/reinstall.sh

# Build only (no install)
bun run belz:build                     # produces apps/cli/belz

# Run in dev mode (no compile step)
bun apps/cli/bin/cli.ts ad show --help
```

See `apps/cli/AGENTS.md` for full build and development details.

### Wire fixtures

`scripts/fixtures/capture.ts` captures real API responses into each module's
`tests/fixtures/…` (with `manifest.json`). It is **read-only** (GET only) and
**sems-dev only**, and runs every body through `scripts/fixtures/sanitize.ts`
(tokens, cookies, secret keys, auth `fieldValue`s, e-mails, phones).
`scripts/fixtures/fixtures-secrets.test.ts` scans every `fixtures/` dir and fails
on anything that looks like a secret or PII — re-run
`bun scripts/fixtures/capture.ts resanitize <dir>` if it trips.

---

## Key Shared Patterns

- All commands implement `CommandModule` from `@belzabar/core` (`parseArgs` + `execute` + optional `presentHuman`)
- `ok(data)` / `fail(message)` / `throw new CliError(message)` for results
- `--llm` flag outputs a structured JSON envelope; `--env` sets the active environment
- **All user-facing UI goes through `@belzabar/core`'s unified `ui` module** — prompts, spinners, tables, log.* helpers. Never use `inquirer`, `chalk`, or hand-rolled readline selectors. See `packages/core/AGENTS.md` for the surface. Prompts automatically refuse in `--llm` mode.
- `help.txt` files live alongside each command's `index.ts` and follow a strict template
  (defined in `integrations/automation-designer/AGENTS.md`)
- `desc.txt` files live alongside each `help.txt`; one line per invocation variant in format
  `<full invocation>  :->  <what it does>`. Embedded via the registry into `belz --help-full`.
  Update `desc.txt` whenever you add, remove, or change flags on a command.
- Adding/removing a command = adding/removing its folder **and** its entry in that module's
  `registry.ts` (keep it sorted). `apps/cli/tests/registry.test.ts` fails if they disagree.

---

## Where to Start

- Working on an AD command? Read `integrations/automation-designer/AGENTS.md`
- Working on a PD command? Read `integrations/page-designer/AGENTS.md`
- Working on the CLI entry point, build, or top-level commands? Read `apps/cli/AGENTS.md`
- Working on migrations? Read `integrations/migrations/AGENTS.md` (Jenkins client: `integrations/jenkins/AGENTS.md`)
- Working on the browser extension? Read `apps/extension/AGENTS.md`
- Working on `@belzabar/core`? Read `packages/core/AGENTS.md`
