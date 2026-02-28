# AGENTS.md — Belzabar Repository

## You Are the Maintainer Agent

You are working inside the **Belzabar** monorepo. Your role is to understand, extend, and
maintain this codebase. Before making changes in any module, read that module's `AGENTS.md`.

**Standing instruction:** Whenever you make a meaningful change to any module — new commands,
changed behavior, new files, API changes, structural reorganization — you **must** update the
`AGENTS.md` in that module. If the overall repository structure changes, update this root
`AGENTS.md` as well. Additionally, if any functional change affects how `belz` is used (new
commands, changed flags, changed behavior that a runtime agent would need to know about), you
**must** also update the relevant `INIT.md` file(s) in `agents/`. Keep these files accurate;
they are the primary orientation documents for future Maintainer Agents and runtime agents.

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
| `automation-designer/` | AD command implementations and supporting lib (source module) | `automation-designer/AGENTS.md` |
| `page-designer/` | PD command implementations and supporting lib (source module) | `page-designer/AGENTS.md` |
| `migrations/` | Migration library consumed by `belz migrate` (source module) | `migrations/AGENTS.md` |
| `extension/` | Browser extension (MV3, JavaScript) | `extension/AGENTS.md` |
| `packages/core/` | `@belzabar/core` — shared CLI framework (workspace package) | `packages/core/AGENTS.md` |
| `docs/` | Generated/maintained documentation (codebase-map.html) | — |
| `specs/` | Specification documents | — |
| `agents/` | Agent-specific reference files | — |

---

## Monorepo Structure

This is a **Bun workspaces** monorepo managed with Turborepo.

**Workspaces** (have `package.json`, hoisted dependencies):
- `cli` — the CLI build workspace
- `extension` — the browser extension workspace
- `packages/*` — shared packages (`@belzabar/core`)

**Source modules** (no `package.json` — imported directly by `cli/` via relative paths):
- `automation-designer/`
- `page-designer/`
- `migrations/`

Source modules are intentionally not workspaces. They contain pure TypeScript source that `cli/`
imports at build time. This keeps the dependency graph simple and the binary self-contained.

---

## How `belz` Routes Commands

```
belz ad <cmd>      → automation-designer/commands/<cmd>/
belz pd <cmd>      → page-designer/commands/<cmd>/
belz migrate       → cli/commands/migrate/ + migrations/lib/
belz envs          → cli/commands/envs/
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
- `help.txt` files live alongside each command's `index.ts` and follow a strict template
  (defined in `automation-designer/AGENTS.md`)
- Registry files in `cli/commands/registry-*.ts` are auto-generated — run `bun run generate`
  from `cli/` after adding/removing commands

---

## Where to Start

- Working on an AD command? Read `automation-designer/AGENTS.md`
- Working on a PD command? Read `page-designer/AGENTS.md`
- Working on the CLI entry points, build, or registries? Read `cli/AGENTS.md`
- Working on migrations? Read `migrations/AGENTS.md`
- Working on the browser extension? Read `extension/AGENTS.md`
- Working on `@belzabar/core`? Read `packages/core/AGENTS.md`
