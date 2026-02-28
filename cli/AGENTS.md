# AGENTS.md — CLI

## Purpose

The `cli/` directory is the **orchestration layer** for the `belz` unified binary. It owns:

- Entry points (dev and prod)
- Command registries (auto-generated)
- Top-level commands (`envs`, `migrate`)
- Registry generation script
- Install / reinstall scripts
- Build configuration

**No business logic lives here.** All command implementations are in the source modules:
`automation-designer/`, `page-designer/`, and `migrations/`. The `cli/` only wires them together.

---

## Directory Map

```
cli/
├── bin/
│   ├── cli.ts              Dev-mode entry point (dynamic command discovery)
│   └── cli-build.ts        Prod-mode entry point (pre-generated registries)
├── commands/
│   ├── envs/               Top-level `belz envs` command
│   │   ├── index.ts
│   │   └── help.txt
│   ├── migrate/            Top-level `belz migrate` command (passthrough to migrations/lib)
│   │   ├── index.ts
│   │   └── help.txt (+ README.md)
│   ├── registry-ad.ts      Auto-generated — AD command registry
│   ├── registry-pd.ts      Auto-generated — PD command registry
│   ├── registry-top.ts     Auto-generated — top-level command registry
│   └── registry-help.ts    Auto-generated — embedded help text (for compiled binary)
├── utils/
│   └── generate-registry.ts  Generates all 4 registry files
├── scripts/
│   ├── install.sh          Build + install + first-time credential setup
│   └── reinstall.sh        Wipe ~/.belz + fresh install (delegates to install.sh)
├── package.json            Scripts: generate, build, install-cli, link
├── tsconfig.json
└── bun.lock
```

---

## Dev Mode vs Prod Mode

### Dev mode — `bin/cli.ts`

Used during development (`bun run bin/cli.ts`). Discovers commands dynamically via `readdirSync`
on the source module directories. No registry files needed. Help text is read from `help.txt`
files on disk at runtime.

### Prod mode — `bin/cli-build.ts`

Used for the compiled binary (`bun run build`). Imports from the pre-generated registry files
and uses embedded help text (all bundled at compile time — no filesystem access required).

The `bun build --compile` step bakes everything into a single self-contained binary.

---

## Namespace Routing

The entry points call `runNamespacedCli` from `@belzabar/core` with this structure:

```
belz ad <cmd>      → ADCommandRegistry (automation-designer/commands/)
belz pd <cmd>      → PDCommandRegistry (page-designer/commands/)
belz migrate       → migrate command (passthrough module, not a namespace)
belz envs          → envs command (top-level)
belz --help        → unified help listing all modules + top-level commands
```

`migrate` is wired as a **passthrough module** (single `command` key, not `commands`), meaning
`belz migrate <subcommand>` is handled entirely inside `commands/migrate/index.ts`.

---

## Registry Generation

The 4 registry files are **auto-generated** — do not edit them manually.

```bash
# Run from cli/
bun run generate
```

This runs `utils/generate-registry.ts`, which:
1. Discovers AD commands from `../automation-designer/commands/` (any folder with `index.ts`)
2. Discovers PD commands from `../page-designer/commands/`
3. Discovers top-level commands from `commands/` (envs, migrate)
4. Writes `commands/registry-{ad,pd,top,help}.ts`

**Always commit the generated registry files** after adding or removing commands.

---

## Adding Commands

### New top-level command
1. Create `commands/<name>/index.ts` (implement `CommandModule`) and `commands/<name>/help.txt`
2. Run `bun run generate` from `cli/` — the command is auto-discovered
3. Commit the updated `registry-top.ts` and `registry-help.ts`

### New AD command
Add to `../automation-designer/commands/` — see `automation-designer/AGENTS.md`.

### New PD command
Add to `../page-designer/commands/` — see `page-designer/AGENTS.md`.

### New namespace
1. Add entry point logic to both `bin/cli.ts` and `bin/cli-build.ts`
2. Add a new registry generator block to `utils/generate-registry.ts`
3. Create the source module at the repo root alongside `automation-designer/`

---

## Build

```bash
cd cli

# Generate registries (required before build)
bun run generate

# Compile the binary
bun run build
# → produces cli/belz

# Install to ~/.local/bin
bun run install-cli
```

Or from the repo root:
```bash
bun run install   # runs cli/scripts/install.sh (generate + build + install + first-time setup)
```

---

## Install Scripts

Both scripts live in `cli/scripts/`. Run them from anywhere:

```bash
bash ./cli/scripts/install.sh [--env-file <path>] [--install-dir <dir>]
bash ./cli/scripts/reinstall.sh [--env-file <path>] [--install-dir <dir>] [--yes]
```

**`install.sh`** — Smart install/update:
- If `belz` is already installed: rebuilds binary only (credentials untouched)
- If not installed: runs first-time setup (prompts for credentials or reads `--env-file`)
- Writes `~/.belz/config.json`, then builds and installs the binary

**`reinstall.sh`** — Clean wipe + fresh install:
- Deletes `~/.belz/` and the existing binary
- Then delegates to `install.sh`

Both scripts compute `REPO_ROOT` two levels up from `cli/scripts/` (`$SCRIPT_DIR/../..`).

---

## Help Text Standard

Every command (`commands/envs/`, `commands/migrate/`, and all source-module commands) must have
a `help.txt` following the standard defined in `automation-designer/AGENTS.md`.

---

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this directory — new commands,
changed entry-point logic, new scripts, structural changes — update this `AGENTS.md`.

If you add or remove commands from any source module, run `bun run generate` and commit the
updated registry files alongside your other changes.
