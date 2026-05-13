# AGENTS.md — Belzabar Repository

## You Are the Maintainer Agent

You are working inside the **Belzabar** monorepo. Your role is to understand, extend, and
maintain this codebase. Before making changes in any module, read that module's `AGENTS.md`.

**Standing instruction:** Whenever you make a meaningful change to any module — new commands,
changed behavior, new files, API changes, structural reorganization — you **must** update the
`AGENTS.md` in that module. If the overall repository structure changes, update this root
`AGENTS.md` as well. If you add, remove, or change flags on any command, update that command's
`desc.txt` — this is what `belz --help-full` outputs and what runtime agents use as their
command reference. The `INIT.md` files in `specs/` are now stable and do **not** need manual
updates when commands change (they reference `belz --help-full` instead).

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

| Directory | Role | AGENTS.md |
|-----------|------|-----------|
| `cli/` | Builds the `belz` binary; owns entry points, registries, install scripts | `cli/AGENTS.md` |
| `cli/packages/core/` | `@belzabar/core` — shared CLI framework (workspace package) | `cli/packages/core/AGENTS.md` |
| `integrations/automation-designer/` | AD command implementations and supporting lib (source module) | `integrations/automation-designer/AGENTS.md` |
| `integrations/page-designer/` | PD command implementations and supporting lib (source module) | `integrations/page-designer/AGENTS.md` |
| `integrations/teamwork/` | Teamwork command implementations and supporting lib (source module) | `integrations/teamwork/AGENTS.md` |
| `integrations/migrations/` | Jenkins migration library + commands consumed by `belz migrate` (source module) | `integrations/migrations/AGENTS.md` |
| `integrations/migrations/legacy/` | Legacy NSM db-migration-tool client (retained for fallback) | `integrations/migrations/legacy/AGENTS.md` |
| `extension/` | Browser extension (MV3, JavaScript) | `extension/AGENTS.md` |
| `web/` | Next.js web dashboard served by `belz web` | — |

---

## Monorepo Structure

This is a **Bun workspaces** monorepo managed with Turborepo.

**Workspaces** (have `package.json`, hoisted dependencies):
- `cli` — the CLI build workspace
- `cli/packages/*` — shared packages (`@belzabar/core`)
- `extension` — the browser extension workspace
- `apps/*` — application workspaces

**Source modules** (no `package.json` — imported directly by `cli/` via relative paths):
- `integrations/automation-designer/`
- `integrations/page-designer/`
- `integrations/teamwork/`
- `integrations/migrations/` (the Jenkins flow)
- `integrations/migrations/legacy/` (legacy db-migration-tool fallback)

Source modules are intentionally not workspaces. They contain pure TypeScript source that `cli/`
imports at build time. This keeps the dependency graph simple and the binary self-contained.

---

## How `belz` Routes Commands

```
belz ad <cmd>      → integrations/automation-designer/commands/<cmd>/
belz pd <cmd>      → integrations/page-designer/commands/<cmd>/
belz tw <cmd>      → integrations/teamwork/commands/<cmd>/
belz migrate <cmd> → integrations/migrations/commands/<cmd>/
belz migrate-legacy → cli/commands/migrate-legacy/ + integrations/migrations/legacy/lib/
belz config        → cli/commands/config/
belz cache         → cli/commands/cache/
belz web           → cli/commands/web/
belz envs          → cli/commands/envs/
belz setup         → cli/commands/setup/   (interactive first-time credentials)
```

The routing is implemented in `packages/core/src/runner.ts` (`runNamespacedCli`). The `cli/`
directory owns the entry points that wire everything together.

**Environments:** `nsm-dev`, `nsm-qa`, `nsm-uat` (pass `--env <name>`, default: `nsm-dev`).

---

## Runtime Data

Everything lives under `~/.belz/`:

| Path | Contents |
|------|----------|
| `~/.belz/config.json` | Optional credentials (config file wins over env vars) |
| `~/.belz/sessions/<env>.json` | Saved auth sessions per environment |
| `~/.belz/cache/methods/<uuid>.json` | Method cache (5-minute TTL) |
| `~/.belz/cache/definitions/<id>.json` | Automation definition cache |
| `~/.belz/migrations/nsm-profiles.json` | Migration profile cache |

---

## Build and Install

```bash
# Install / update the belz binary (from repo root)
bun run install                        # or: bash ./cli/scripts/install.sh

# Clean wipe + fresh install
bun run reinstall                      # or: bash ./cli/scripts/reinstall.sh

# Build only (no install)
cd cli && bun run build               # produces cli/belz

# Run in dev mode (no compile step)
cd cli && bun run bin/cli.ts ad get --help
```

See `cli/AGENTS.md` for full build and development details.

---

## Key Shared Patterns

- All commands implement `CommandModule` from `@belzabar/core` (`parseArgs` + `execute` + optional `presentHuman`)
- `ok(data)` / `fail(message)` / `throw new CliError(message)` for results
- `--llm` flag outputs a structured JSON envelope; `--env` sets the active environment
- **All user-facing UI goes through `@belzabar/core`'s unified `ui` module** — prompts, spinners, tables, log.* helpers. Never use `inquirer`, `chalk`, or hand-rolled readline selectors. See `packages/core/AGENTS.md` for the surface. Prompts automatically refuse in `--llm` mode.
- `help.txt` files live alongside each command's `index.ts` and follow a strict template
  (defined in `automation-designer/AGENTS.md`)
- `desc.txt` files live alongside each `help.txt`; one line per invocation variant in format
  `<full invocation>  :->  <what it does>`. Collected at build time into `belz --help-full`.
  Update `desc.txt` whenever you add, remove, or change flags on a command.
- Registry files in `cli/commands/registry-*.ts` are auto-generated — run `bun run generate`
  from `cli/` after adding/removing commands (this also rebuilds `HELP_FULL_TEXT`)

---

## Where to Start

- Working on an AD command? Read `automation-designer/AGENTS.md`
- Working on a PD command? Read `page-designer/AGENTS.md`
- Working on the CLI entry points, build, or registries? Read `cli/AGENTS.md`
- Working on migrations? Read `migrations/AGENTS.md`
- Working on the browser extension? Read `extension/AGENTS.md`
- Working on `@belzabar/core`? Read `packages/core/AGENTS.md`
