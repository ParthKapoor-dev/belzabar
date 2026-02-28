# Belzabar Tools

Internal developer toolset for working with the NSM (Notice & Storage System) platform.
Ships two products: the **`belz` CLI** and a **browser extension**.

---

## Contents

- [What's in This Repo](#whats-in-this-repo)
- [Prerequisites](#prerequisites)
- [Install the CLI](#install-the-cli)
- [belz CLI Reference](#belz-cli-reference)
  - [Global Flags](#global-flags)
  - [Automation Designer — `belz ad`](#automation-designer--belz-ad)
  - [Page Designer — `belz pd`](#page-designer--belz-pd)
  - [Migrations — `belz migrate`](#migrations--belz-migrate)
  - [Environments — `belz envs`](#environments--belz-envs)
- [Credentials and Config](#credentials-and-config)
- [Browser Extension](#browser-extension)
- [Development](#development)
- [Repository Structure](#repository-structure)

---

## What's in This Repo

| Product | Description |
|---------|-------------|
| **`belz` CLI** | Unified command-line tool for inspecting, testing, and running Automation Designer (AD) methods, analyzing Page Designer (PD) pages, and running database migrations. |
| **Browser Extension** | Content script (MV3) that enhances the AD and PD web UIs with a JSON bulk-editor, textarea CodeMirror modal, output copy button, run-test keyboard shortcut, and extension settings. |

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.x

```bash
curl -fsSL https://bun.sh/install | bash
```

---

## Install the CLI

Clone the repo and run the install script. It handles dependencies, builds the binary, and walks you through first-time credential setup.

```bash
git clone <repo-url> belzabar && cd belzabar
bun run install
```

The script will prompt for a `.env` credentials file or let you enter credentials manually for each environment.

**Update an existing install** (rebuilds binary, preserves credentials):

```bash
bun run install
```

**Clean wipe + fresh install** (deletes `~/.belz/` and the binary):

```bash
bun run reinstall
```

Both scripts accept `--env-file <path>` and `--install-dir <dir>`. `reinstall` also accepts `--yes` to skip confirmation.

After install, `belz` is placed in `~/.local/bin/`. Make sure it's on your `PATH`:

```bash
export PATH="$PATH:$HOME/.local/bin"
```

---

## belz CLI Reference

### Global Flags

Available on every command:

| Flag | Description |
|------|-------------|
| `--env <name>` | Set active environment. Default: `nsm-dev`. Options: `nsm-dev`, `nsm-qa`, `nsm-uat` |
| `--llm` | Output a structured JSON envelope instead of formatted text — useful for scripting or AI-assisted workflows |
| `--help`, `-h` | Show usage, arguments, flags, and examples for any command |

```bash
belz ad get <UUID> --env nsm-qa --llm
```

---

### Automation Designer — `belz ad`

Commands for working with AD methods.

| Command | Description |
|---------|-------------|
| `belz ad get <UUID>` | Fetch a method by UUID or referenceId. Returns metadata and input definitions. |
| `belz ad show <UUID>` | Deep inspection: all inputs, service steps with mappings, outputs. Flags: `--inputs`, `--services`, `--service-detail <n>`, `--full`, `--raw`. |
| `belz ad test <UUID>` | Run a test payload against the draft method. Accepts input from a JSON file or interactive prompts. Shows per-step execution trace. |
| `belz ad run <UUID>` | Execute the published method in live mode with a provided payload. |
| `belz ad save-suite <UUID>` | Save the current test inputs as a named spec to `suites/*.spec.json`. |
| `belz ad run-suites` | Run all saved test suite specs and report pass/fail results. |
| `belz ad sql` | SQL interface. Sub-commands: `dbs` (list databases), `run <db> <query>`, `tui` (interactive session). |

**Examples:**

```bash
# Fetch a method and see its inputs
belz ad get LT-260.get

# Deep inspection of a method's services
belz ad show <UUID> --services

# Test a method interactively
belz ad test <UUID>

# Test using a saved input file
belz ad test <UUID> --input inputs.json

# Run in QA environment
belz ad run <UUID> --env nsm-qa

# Get structured JSON output for scripting
belz ad show <UUID> --llm | jq '.data.method.inputs'

# Open interactive SQL session
belz ad sql tui
```

---

### Page Designer — `belz pd`

Commands for inspecting and analyzing PD pages and components.

| Command | Description |
|---------|-------------|
| `belz pd show-page <DRAFT_ID>` | Fetch and display page config, layout structure, and referenced AD method IDs. |
| `belz pd show-component <NAME>` | Search for and display a component's config and AD refs by component name. |
| `belz pd find-ad-methods <ID>` | Extract all AD method IDs referenced in a page or component. Supports `--recursive`. |
| `belz pd inspect-url <PD_URL>` | Parse a full PD URL (`/ui-designer/page/...` or `/ui-designer/symbol/...`) and return metadata, children, and AD refs. |
| `belz pd analyze [PAGE_ID]` | Recursive dependency and compliance analysis from root pages. Compares discovered AD IDs against `master_ids.txt`. |

**Examples:**

```bash
# Inspect a page by its draft UUID
belz pd show-page 4446632159c2d9b4acf2b4b307aeb367

# Inspect a component by name
belz pd show-component n_s_public_LT_260_Form

# Find all AD methods in a page, recursively
belz pd find-ad-methods <PAGE_ID> --recursive

# Inspect from a browser URL
belz pd inspect-url "https://nsm-dev.nc.verifi.dev/ui-designer/page/<id>"

# Run full compliance analysis
belz pd analyze
```

---

### Migrations — `belz migrate`

Commands for running NSM database migrations (AD methods and PD pages across environments).

| Command | Description |
|---------|-------------|
| `belz migrate profiles` | List available migration profiles (source → target environment pairs). Use `--refresh` to bypass cache. |
| `belz migrate run` | Trigger a migration run. Requires `--module` and `--ids`. Streams live log output via WebSocket. |

**Examples:**

```bash
# List available migration profiles
belz migrate profiles

# Migrate specific AD method IDs from dev to QA
belz migrate run --module AD --ids "id1,id2,id3"

# Migrate with explicit environments
belz migrate run --module AD --ids "id1" --source-env nsm-dev --target-env nsm-qa
```

> Only **Published** IDs can be migrated. If a fix isn't visible in QA, verify it was published and then migrated.

---

### Environments — `belz envs`

```bash
belz envs
```

Lists all configured environments (`nsm-dev`, `nsm-qa`, `nsm-uat`) with the active environment flagged.

---

## Credentials and Config

On first install, credentials are saved to `~/.belz/config.json` (mode `600`). The config file takes precedence over environment variables.

**Config format:**

```json
{
  "environments": {
    "nsm-dev":  { "url": "https://nsm-dev.nc.verifi.dev", "user": "...", "password": "<base64>" },
    "nsm-qa":   { "url": "https://nsm-qa.nc.verifi.dev",  "user": "...", "password": "<base64>" },
    "nsm-uat":  { "url": "https://nsm-uat.nc.verifi.dev", "user": "...", "password": "<base64>" }
  }
}
```

`password` is base64-encoded. Omitting a field falls back to the corresponding env var (`NSM_DEV_USER`, `NSM_DEV_PASSWORD`, etc.).

**Runtime data** — everything lives under `~/.belz/`:

| Path | Contents |
|------|----------|
| `~/.belz/config.json` | Credentials |
| `~/.belz/sessions/<env>.json` | Auth sessions (auto-managed) |
| `~/.belz/cache/methods/<uuid>.json` | Method cache (5-minute TTL) |
| `~/.belz/cache/definitions/<id>.json` | Automation definition cache |
| `~/.belz/migrations/nsm-profiles.json` | Migration profile cache |

---

## Browser Extension

The extension enhances the AD and PD web UIs with:

- **JSON editor** — bulk-edit AD test inputs via a modal; syncs values back to DOM controls
- **Textarea editor** — open any native `<textarea>` in a full CodeMirror modal (syntax highlighting, line numbers, wrap toggle)
- **Output copy** — hover-revealed copy button on each output container
- **Run test shortcut** — `Ctrl+Shift+Enter` to trigger the Run Test button from anywhere
- **Extension settings** — `Ctrl+,` or the ⚙ button near the page header; toggles features and stores textarea editor defaults

**Build:**

```bash
cd extension
bun run build
# Produces dist/content-script.js
```

**Load in Chrome/Edge:** Open `chrome://extensions`, enable Developer Mode, click **Load unpacked**, select the `extension/` directory.

---

## Development

### Run CLI in dev mode (no compile step)

```bash
cd cli
bun run bin/cli.ts ad get --help
bun run bin/cli.ts pd show-page --help
bun run bin/cli.ts migrate --help
```

### Regenerate command registries

Required after adding or removing any command:

```bash
cd cli
bun run generate
# Produces: commands/registry-{ad,pd,top,help}.ts
```

### Build the binary

```bash
cd cli
bun run build
# Produces: cli/belz
```

### Run tests

```bash
bun test automation-designer/tests/unit/   # 26 tests
bun test migrations/tests/unit/            # 14 tests
```

### Add an AD command

1. Create `automation-designer/commands/<name>/index.ts` — implement `CommandModule`
2. Create `automation-designer/commands/<name>/help.txt` — follow the help text standard in `automation-designer/AGENTS.md`
3. Run `cd cli && bun run generate` and commit the updated registry files

Same pattern for PD commands (in `page-designer/commands/`).

---

## Repository Structure

```
belzabar/
├── cli/                        Builds the belz binary (Bun workspace)
│   ├── bin/cli.ts              Dev-mode entry point (dynamic discovery)
│   ├── bin/cli-build.ts        Prod-mode entry point (static registries)
│   ├── commands/               Top-level commands + auto-generated registries
│   │   ├── envs/
│   │   ├── migrate/
│   │   ├── registry-ad.ts      ← generated
│   │   ├── registry-pd.ts      ← generated
│   │   ├── registry-top.ts     ← generated
│   │   └── registry-help.ts    ← generated
│   ├── utils/generate-registry.ts
│   └── scripts/
│       ├── install.sh
│       └── reinstall.sh
│
├── automation-designer/        AD commands + lib (source module, no package.json)
│   ├── commands/{get,show,test,run,sql,save-suite,run-suites}/
│   ├── lib/                    api, parser, hydrator, cache, payload-builder, ...
│   ├── lib/sql/                SQL executor, selector, TUI session
│   ├── integrations/gemini-mcp/server.ts   MCP server shim
│   └── tests/unit/
│
├── page-designer/              PD commands + lib (source module, no package.json)
│   ├── commands/{show-page,show-component,find-ad-methods,analyze,inspect-url}/
│   └── lib/                    api, analyzer, parser, comparator, reporter, url-parser
│
├── migrations/                 Migration library (source module, no package.json)
│   └── lib/                    index, args, client, ws, log-parser, profiles, artifacts, report
│
├── extension/                  Browser extension (Bun workspace)
│   └── src/features/           json-editor, textarea-editor, settings, run-test, output-copy, ...
│
├── packages/
│   └── core/                   @belzabar/core — shared framework (Bun workspace)
│       └── src/                config, auth, api, runner, command, output, display
│
├── agents/
│   └── main-orchestrator/      Context files for the Belz-AI runtime agent
│       ├── INIT.md
│       └── BELZABAR.md
│
├── specs/                      Architecture and domain specifications
│   ├── AIM.md                  Belz-AI architecture charter
│   ├── ROADMAP.md              Capability-gated rolling release plan
│   ├── NSM.md                  NSM domain quick reference
│   └── core/BELZABAR.md        Full platform context
│
└── docs/
    └── codebase-map.html       Interactive architecture reference
```

Each major directory has an `AGENTS.md` with detailed guidance for contributors and coding agents. Start there when working in an unfamiliar area.
