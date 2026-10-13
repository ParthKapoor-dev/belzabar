<h1 align="center">belz</h1>

<p align="center">
  <b>One command-line tool for the Expertly low-code platform.</b><br>
  Read, edit, test and publish Automation Designer methods, inspect Page Designer pages,
  run SQL, read Teamwork tickets and trigger migrations — from your terminal or your AI agent.
</p>

<p align="center">
  <a href="https://github.com/ParthKapoor-dev/belzabar/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/ParthKapoor-dev/belzabar?label=release"></a>
  <a href="https://github.com/ParthKapoor-dev/belzabar/actions/workflows/release.yml"><img alt="Release build" src="https://img.shields.io/github/actions/workflow/status/ParthKapoor-dev/belzabar/release.yml?label=build"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-linux%20%7C%20macOS%20%7C%20windows-blue">
  <img alt="Built with Bun" src="https://img.shields.io/badge/built%20with-bun-f9f1e1">
</p>

```bash
curl -fsSL https://github.com/ParthKapoor-dev/belzabar/releases/latest/download/install.sh | bash
```

---

## Contents

- [Why belz?](#why-belz)
- [Installation](#installation)
- [Setup](#setup)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [Automation Designer methods](#automation-designer-methods)
  - [Testing and SQL](#testing-and-sql)
  - [Page Designer pages](#page-designer-pages)
  - [Teamwork, migrations and releases](#teamwork-migrations-and-releases)
  - [Using belz from scripts and AI agents](#using-belz-from-scripts-and-ai-agents)
- [Updating](#updating)
- [Configuration reference](#configuration-reference)
- [Uninstall](#uninstall)
- [Project structure](#project-structure)
- [Development](#development)
- [Releasing](#releasing)

---

## Why belz?

Working on Expertly usually means clicking through the designer UI or hand-crafting REST calls
with encoded payloads. belz does that platform work for you:

- **One tool for everything** — AD methods, PD pages, Report Designer reports, the database, Teamwork tickets, Jenkins
  migrations and release checks.
- **Safe writes** — every write needs an explicit `--env`, asks for confirmation, refuses to
  overwrite a draft someone else changed, and reads the result back to verify it.
- **Readable output** — compact one-line-per-step views, plain-English summaries, diffs.
- **Built for agents** — inside an agent session every command answers with exactly one JSON object.
- **Zero dependencies** — a single binary for Linux, macOS and Windows that keeps itself up to date.

---

## Installation

**Linux and macOS** (x64 and Apple Silicon / arm64):

```bash
curl -fsSL https://github.com/ParthKapoor-dev/belzabar/releases/latest/download/install.sh | bash
```

**Windows** (PowerShell):

```powershell
irm https://github.com/ParthKapoor-dev/belzabar/releases/latest/download/install.ps1 | iex
```

That's it. The installer:

1. downloads the right binary for your OS and CPU,
2. checks it against the release's `SHA256SUMS` (nothing is installed on a mismatch),
3. puts it at `~/.local/bin/belz` (Windows: `%LOCALAPPDATA%\belz\bin\belz.exe`, added to your PATH),
4. starts the guided setup on a first install.

No bun, node or git needed. Check it worked:

```bash
belz --version
```

> If your shell says `belz: command not found`, add `~/.local/bin` to your PATH:
> `export PATH="$PATH:$HOME/.local/bin"` (put it in `~/.bashrc` or `~/.zshrc`).

<details>
<summary><b>Installer options</b></summary>

Pass flags after `bash -s --`, for example
`curl -fsSL …/install.sh | bash -s -- --version 0.2.1`.

| Flag (Linux/macOS) | Windows variable | What it does |
|---|---|---|
| `--version <x.y.z>` | `BELZ_VERSION` | Install that version and pin it (no auto-update) |
| `--install-dir <dir>` | `BELZ_INSTALL_DIR` | Install somewhere else |
| `--env-file <file>` | — | Set up credentials from a file instead of prompting |
| `--no-setup` | `BELZ_NO_SETUP=1` | Skip the first-run setup (CI, scripts, coding agents) |
| `--from-source` | `BELZ_FROM_SOURCE=1` | Clone the repo and build with bun (developers) |

You can also download a binary by hand from the
[releases page](https://github.com/ParthKapoor-dev/belzabar/releases): `belz-linux-x64`,
`belz-linux-arm64`, `belz-darwin-x64`, `belz-darwin-arm64` or `belz-windows-x64.exe`.

</details>

---

## Setup

belz has no built-in environments. You add each one (a name, its base URL and your login) once:

```bash
belz onboard      # guided first run
belz envs         # list your environments and check that login works
```

- Run `belz setup` later to add or change an environment (it merges with what you have).
- Everything is stored in `~/.belz/config.json`, readable only by you. Tokens are refreshed
  automatically.
- With several environments, choose one per command with `--env <name>`, or set a default with
  `belz config edit` (`"defaultEnv"`).

---

## Quick start

```bash
belz ad find "invoice"                 # find methods by name
belz ad show <uuid> --compact          # read one, one line per step
belz ad test <uuid> --env dev --inputs '{"id": 1}'   # run it
belz pd show <page> --tree             # look at a page
belz tw task <id>                      # read a ticket
belz --help-full                       # every command, one line each
```

Every command documents itself: `belz <module> <command> --help`.

---

## Usage

Commands are grouped into modules: `ad` (Automation Designer), `pd` (Page Designer),
`rd` (Report Designer), `tw` (Teamwork), `migrate` (Jenkins migrations), `release` (release audits) and `config`.

### Automation Designer methods

**Find and read**

```bash
belz ad find "<words>"                 # search by name, alias or uuid
belz ad find --describe "<words>"      # "does a method for X already exist?"
belz ad show <uuid> --compact          # one line per step: conditions, loops, SQL, code, I/O
belz ad show <uuid> --story            # plain-English summary for reviews
belz ad state <uuid>                   # is the draft in sync with the published version?
belz ad callers <uuid>                 # who calls this method (--pd adds PD pages)
belz ad grep "<regex>" --all           # search the SQL / code / expressions of every method
belz ad history list <uuid>            # versions; `history diff` compares two
```

**Change, check and publish**

Changes are small JSON *overlays* applied to the method's draft; belz fills in the platform
boilerplate. `belz ad save --help` lists every overlay key.

```bash
belz ad validate <uuid>                                    # check a method
belz ad lint <uuid>                                        # validator + SQL and anti-pattern review
belz ad save edit.json --uuid <uuid> --dry-run             # preview: plan + validate, write nothing
belz ad save edit.json --uuid <uuid> --env dev             # save to the draft
belz ad save --uuid <uuid> --sql-file 3=step3.sql --env dev   # replace one step's SQL
belz ad publish <uuid> --note "fix totals" --env dev       # publish the draft
belz ad create --spec method.json --category <name> --env dev # a new method
```

### Testing and SQL

```bash
belz ad test <uuid> --env dev --inputs inputs.json --expect total=42
belz ad test <uuid> --env dev --inputs inputs.json --compare-published   # draft vs published
belz ad test-case create <uuid> --name smoke --input id=1 --assert status=OK --env dev
belz ad test-case export <uuid> --dir ./tests                # save cases as files
belz ad sql run "select 1"                                   # read-only SQL
belz ad sql explain "select …" --analyze                     # query plan
```

`belz ad test` really runs the method on the server, so it needs `--env`.

### Page Designer pages

```bash
belz pd show <page>                    # by URL, id or exact name; --tree, --vars, --http
belz pd show <page> --find "<text>"    # find a node on the page
belz pd lint <page> --recursive    # check a page and its sub-pages
belz pd find-ad-methods <page>         # which AD methods the page calls
belz pd preflight <pageId> --overlay edit.json   # preview an edit
belz pd save <pageId> --overlay edit.json --env dev
```

### Report Designer reports

```bash
belz rd find "<words>"                 # reports by title
belz rd show <id>                      # definition: datasource, columns, filters (does not run it)
belz rd export <id> --out report.json  # portable spec (datasource by category + method name)
belz rd datasources --category <name>  # published AD methods a report can use
belz rd uses <method-uuid>             # reports fed by an AD method
```

### Teamwork, migrations and releases

```bash
belz tw task <id>                      # a ticket (id or URL)
belz tw comments <id>
belz tw search "<query>"
belz migrate profiles                  # where you can migrate to
belz migrate run --profile <profile> --module AD_Method --ids "<uuid>" --yes
belz release matrix --help             # tickets × environments promotion matrix
```

### Using belz from scripts and AI agents

Inside a coding agent's shell (Claude Code sets `CLAUDECODE=1`; other tools set `BELZ_AGENT=1`)
every command prints the `--llm` envelope by default; elsewhere add `--llm` (`--human` forces the
readable view, `BELZ_AGENT=0` turns the detection off). stdout is then exactly one JSON object:

```json
{ "ok": true, "command": "ad.show", "data": { … }, "error": null, "meta": { … } }
```

On failure `ok` is `false` and `error.code` says what went wrong (for example
`ENV_REQUIRED_FOR_WRITE` or `AD_VERSION_CONFLICT`). In `--llm` mode belz never prompts, so writes
also need `--yes`. When installing belz for an agent, use `--no-setup` and let a person run
`belz onboard` once.

---

## Updating

You don't have to do anything. At most once a day belz checks for a newer release in the
background, downloads and verifies it, and your next run uses it.

```bash
belz update            # update now
belz update --check    # only check
belz update --rollback # go back to the previous version
```

Turn it off with `BELZ_NO_UPDATE=1`, or in `~/.belz/config.json`:
`"update": { "auto": false }` (or `"update": { "pin": "0.2.1" }` to stay on one version).
Major versions are never installed automatically.

---

## Configuration reference

| What | Where |
|---|---|
| Environments, logins, settings | `~/.belz/config.json` (`belz setup`, `belz config edit`) |
| Sessions and caches | `~/.belz/sessions/`, `~/.belz/cache/` (`belz cache prune-local` cleans up) |
| Move all of it | `BELZ_HOME=<dir>` |

**Choosing an environment:** `--env <name>`, then `BELZ_ENV`, then `"defaultEnv"`, then the only
configured environment. **Writes name their environment:** with `--env`, or, at a terminal,
by picking it from a prompt that preselects the default. Agents and scripts must pass `--env`.

**Global flags:** `--env <name>`, `--llm`, `--human`, `-v`/`--verbose`, `--version`, `-h`/`--help`,
`--help-full`.

belz reads only `BELZ_*` environment variables (plus Claude Code's `CLAUDECODE`) and ignores `.env`
files in the current directory. An unknown command or flag mentions `belz update` when a newer
release may have it.

---

## Uninstall

```bash
rm ~/.local/bin/belz     # the binary
rm -rf ~/.belz           # your config, sessions and caches (optional)
```

---

## Project structure

A [Bun](https://bun.sh) workspaces monorepo written in TypeScript. Every directory has its own
README.md.

```
belzabar/
├── apps/cli/                       the `belz` binary: entry point, top-level commands, self-update
├── packages/core/                  shared framework: args, runner + --llm envelope, config, http, cache, ui
├── integrations/
│   ├── automation-designer/        belz ad …
│   ├── page-designer/              belz pd …
│   ├── report-designer/            belz rd …
│   ├── teamwork/                   belz tw …
│   ├── migrations/                 belz migrate …
│   └── release/                    belz release …
├── scripts/                        docs check, dead-code check, release script, fixture capture
├── cloud/                          setup for Claude Code cloud sessions
├── install.sh, install.ps1         the one-line installers
└── .github/workflows/release.yml   builds and publishes a release
```

| Path | Package | Role |
|------|---------|------|
| [`apps/cli/`](./apps/cli/README.md) | `belzabar.cli` | The binary; `cache`, `config`, `envs`, `onboard`, `setup`, `update` |
| [`packages/core/`](./packages/core/README.md) | `@belzabar/core` | Shared CLI framework |
| [`integrations/automation-designer/`](./integrations/automation-designer/README.md) | `@belzabar/ad` | `belz ad …` |
| [`integrations/page-designer/`](./integrations/page-designer/README.md) | `@belzabar/pd` | `belz pd …` |
| [`integrations/report-designer/`](./integrations/report-designer/README.md) | `@belzabar/rd` | `belz rd …` |
| [`integrations/teamwork/`](./integrations/teamwork/README.md) | `@belzabar/teamwork` | `belz tw …` |
| [`integrations/migrations/`](./integrations/migrations/README.md) | `@belzabar/migrations` | `belz migrate …` |
| [`integrations/release/`](./integrations/release/README.md) | `@belzabar/release` | `belz release …` |
| [`scripts/`](./scripts/README.md) | — | Repo-wide checks and the release script |
| [`cloud/`](./cloud/README.md) | — | Cloud-session bootstrap |

Each integration exports a sorted command registry (`./registry`) and its libraries (`./lib/*`);
`apps/cli/bin/options.ts` wires them into `belz`. Packages import each other by package name,
never by relative paths. The command reference is `belz --help-full`; agent working rules are in
`AGENTS.md`.

---

## Development

```bash
git clone https://github.com/ParthKapoor-dev/belzabar.git && cd belzabar
bun install --ignore-scripts
bun apps/cli/bin/cli.ts ad show <uuid>      # run from source, no build
bun run check                               # typecheck + docs check + dead code + all tests
bun test integrations/automation-designer   # one package
bun run belz:install                        # build and install your local binary
```

- Tests never touch your real `~/.belz` (they use a temporary `BELZ_HOME`).
- Opt-in live tests (read-only): `BELZ_LIVE=<env> bun test apps/cli/tests/live`.
- Test fixtures are sanitized and `scripts/fixtures/fixtures-secrets.test.ts` fails on anything
  that looks like a secret. Never commit `~/.belz/config.json`.
- Adding a command: see `AGENTS.md`.

---

## Releasing

```bash
bun run release patch --dry-run    # show the next version
bun run release patch              # or minor | major | x.y.z
```

Run from a clean `main` that matches `origin/main`. The script bumps the version, commits, tags
`vX.Y.Z` and pushes. The tag starts `.github/workflows/release.yml`, which runs `bun run check`,
builds the five binaries, smoke-tests each on its own OS and CPU, and publishes a GitHub Release
with `SHA256SUMS`, `manifest.json` and the installers. Every installed belz picks it up within a
day. Details: [`apps/cli/lib/README.md`](./apps/cli/lib/README.md).
