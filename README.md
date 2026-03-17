# Belzabar

Internal developer toolset for NSM platform engineers. Ships the **`belz` CLI**, a **browser extension**, and a **web AI interface**.

---

## Prerequisites

[Bun](https://bun.sh) ≥ 1.x

```bash
curl -fsSL https://bun.sh/install | bash
```

---

## Install the CLI

```bash
git clone <repo-url> belzabar && cd belzabar
bun run install
```

The script builds the binary, installs it to `~/.local/bin/belz`, and walks you through credential setup. Make sure `~/.local/bin` is on your `PATH`.

**Update** (rebuilds binary, keeps credentials):
```bash
bun run install
```

**Full wipe + reinstall** (deletes `~/.belz/` and the binary):
```bash
bun run reinstall
```

Both scripts accept `--env-file <path>` and `--install-dir <dir>`. `reinstall` also accepts `--yes`.

---

## CLI Usage

```bash
# Automation Designer
belz ad get <UUID>                     # fetch method metadata
belz ad show <UUID> --full             # deep-inspect services + inputs
belz ad test <UUID>                    # run with per-step trace
belz ad test <UUID> --input file.json  # test with a JSON payload
belz ad run <UUID>                     # execute published method live
belz ad sql tui                        # interactive SQL session

# Page Designer
belz pd show-page <DRAFT_ID>
belz pd show-component <NAME>
belz pd find-ad-methods <ID> --recursive
belz pd inspect-url "https://nsm-dev.nc.verifi.dev/ui-designer/page/<id>"
belz pd analyze

# Migrations
belz migrate profiles
belz migrate run --module AD --ids "id1,id2"

# Environments
belz envs

# Global flags (work on every command)
belz ad get <UUID> --env nsm-qa        # target a specific environment
belz ad show <UUID> --llm              # JSON output for scripting / AI
```

---

## Browser Extension

Build and load:

```bash
cd extension && bun run build
# Load extension/ as unpacked in chrome://extensions (Developer Mode)
```

**Shortcuts on NSM pages:**
- `Ctrl+Shift+Enter` — trigger Run Test
- `Ctrl+,` — open extension settings

---

## Web App (AI Sessions)

```bash
cd web && bun run dev
# Open http://localhost:3000
```

- `/` — landing page; `Ctrl+V` anywhere auto-opens AD method from a curl command
- `/ai` — create and manage AI agent sessions (Claude, Gemini, Codex, OpenCode)
- `/curl` — paste a curl command to open the AD page with inputs pre-filled

---

## Development

```bash
# Run CLI without building
cd cli && bun run bin/cli.ts ad get --help

# Regenerate command registries (required after adding/removing commands)
cd cli && bun run generate

# Build binary only
cd cli && bun run build

# Tests
bun test automation-designer/tests/unit/
bun test migrations/tests/unit/
```

---

## Adding a Command

```
automation-designer/commands/<name>/
  ├── index.ts    # implement CommandModule
  └── help.txt    # usage text

# Then:
cd cli && bun run generate
```

Same pattern for `page-designer/commands/` (pd) and `cli/commands/` (top-level).

Each module's `AGENTS.md` has detailed contributor guidance.

---

## Credentials

Stored at `~/.belz/config.json` (mode 600). The file takes precedence over env vars (`NSM_DEV_URL`, `NSM_DEV_USER`, `NSM_DEV_PASSWORD`, and equivalents for `QA`/`UAT`).

---

For technical internals, see [`docs/index.html`](docs/index.html).
