# Belzabar

Developer toolset for NSM platform engineers. Ships the **`belz` CLI**, a **browser extension**, and a **web dashboard**.

---

## Quick install

One line, anywhere:

```bash
curl -fsSL https://raw.githubusercontent.com/ParthKapoor-dev/belzabar/main/install.sh | bash
```

This installs [`bun`](https://bun.sh) if you don't have it, clones the repo into `~/.belz/src`, builds the `belz` binary, drops it at `~/.local/bin/belz`, and walks you through credential setup the first time.

Make sure `~/.local/bin` is on your `PATH`.

**To update** (preserves credentials, sessions, and cache): re-run the same one-liner.

**Forwarded flags** (non-interactive setups):

```bash
curl -fsSL https://raw.githubusercontent.com/ParthKapoor-dev/belzabar/main/install.sh \
  | bash -s -- --env-file ./belz.env --install-dir /opt/bin
```

---

## Manual install (for development)

```bash
git clone https://github.com/ParthKapoor-dev/belzabar.git
cd belzabar
bun install
bun run install            # builds + installs binary + first-run setup
```

**Full wipe + reinstall** (deletes `~/.belz/` and the binary):

```bash
bun run reinstall
```

---

## CLI tour

```bash
# Automation Designer
belz ad show <uuid> --open              # inspect + open editable draft in browser
belz ad find <query>                    # fuzzy-find methods
belz ad save <uuid> --json patch.json   # safe edit (lock + validate + apply)
belz ad run <uuid>                      # execute published method live
belz ad sql tui                         # interactive SQL session

# Page Designer
belz pd show <name-or-id> --open        # inspect page/component, open in browser
belz pd find <query>                    # fuzzy-find pages/components
belz pd save <uuid> --json patch.json   # safe edit
belz pd publish <uuid>                  # promote draft to published
belz pd preflight <uuid>                # validator-only (CI gate)
belz pd history <uuid>                  # browse / restore versions
belz pd analyze                         # static analysis across all pages

# Migrations (Jenkins-backed)
belz migrate profiles                   # list available profiles
belz migrate run --profile devncdns_qancdns --module AD_Method --ids "<uuid>"
belz migrate status <buildNumber>
belz migrate log <buildNumber>

# Migrations (legacy db-migration-tool, retained as a fallback)
belz migrate-legacy run --profile devncdns_qancdns --module AD_Method --ids "<uuid>"

# Teamwork
belz tw task <id>                       # show a Teamwork task
belz tw comments <id>                   # task comments

# Cache + Config + Envs
belz cache <uuid>                       # invalidate a server-side cache entry
belz config                             # manage ~/.belz/config.json
belz envs                               # list configured environments
belz setup                              # re-run interactive credential setup

# Web dashboard
belz web start                          # run the local Next.js dashboard
belz web stop
belz web status
```

**Global flags** (work on every command):

| Flag | Purpose |
|------|---------|
| `--env <name>` | Target a specific environment (`nsm-dev` / `nsm-qa` / `nsm-uat` / `nsm-stage`). |
| `--llm` | Emit a structured JSON envelope for scripting or LLM consumption. |
| `--help, -h` | Per-command help. |

Run `belz --help-full` for a one-screen tour of every command with its one-line description.

---

## Browser extension

```bash
cd extension && bun run build
# In Chrome: chrome://extensions → Developer Mode → Load unpacked → pick extension/
```

Active on `nsm-dev`, `nsm-qa`, `nsm-uat`, `nsm-stage`, and `staff-nss.verifi-nc.com` (NSM-prod).

**Shortcuts**: `Ctrl+Shift+Enter` runs Run Test from anywhere on an AD method page; `Shift+L` copies a rich AD/PD link.

See `extension/README.md` for the full feature list.

---

## Web dashboard

```bash
belz web start            # runs at http://localhost:65535
belz web stop
belz web status
```

Features include VIN lookup (forward + reverse), an environment-scoped search box, and a curl-paste flow that opens the right AD method with inputs prefilled.

---

## Repo layout

```
belzabar/
├── cli/                        the belz binary workspace
│   ├── bin/                    entry points (cli.ts dev mode, cli-build.ts prod)
│   ├── commands/               top-level commands + generated registries
│   ├── packages/core/          @belzabar/core — shared CLI framework
│   ├── scripts/                install.sh, reinstall.sh
│   └── utils/                  registry generator
├── integrations/               source modules wired into belz
│   ├── automation-designer/    belz ad …
│   ├── page-designer/          belz pd …
│   ├── teamwork/               belz tw …
│   └── migrations/
│       ├── commands/  lib/     belz migrate …  (Jenkins flow)
│       └── legacy/             belz migrate-legacy …  (db-migration-tool)
├── extension/                  browser extension (MV3, JavaScript)
├── web/                        Next.js dashboard served by `belz web`
└── install.sh                  the public one-line installer
```

Each integration module has its own `AGENTS.md` describing conventions, lib layout, and how to add new commands.

---

## Adding a command

```
integrations/<module>/commands/<cmd>/
├── index.ts     # exports a default CommandModule
├── help.txt     # full --help text
└── desc.txt     # one-line description for `belz --help-full`
```

Then regenerate the registries:

```bash
cd cli && bun run generate
```

Use the existing commands as templates — see e.g. `integrations/page-designer/commands/show/index.ts`.

---

## Development

```bash
# Run CLI without building
bun cli/bin/cli.ts ad show <uuid>

# Regenerate command registries after adding/removing commands
cd cli && bun run generate

# Build the binary
cd cli && bun run build

# Tests
bun test integrations/automation-designer/tests/unit/
bun test integrations/page-designer/tests/unit/
bun test integrations/migrations/legacy/tests/unit/
```

---

## Configuration

Credentials live at `~/.belz/config.json` (mode 600). Re-run `belz setup` any time to refresh. The config file takes precedence over env vars (`NSM_DEV_URL`, `NSM_DEV_USER`, `NSM_DEV_PASSWORD`, equivalents for `QA`/`UAT`/`STAGE`, plus `BELZ_JENKINS_*` for the Jenkins migration flow).

Runtime data under `~/.belz/`:

| Path | Contents |
|------|----------|
| `~/.belz/config.json` | Credentials per environment + Jenkins config |
| `~/.belz/sessions/<env>.json` | Saved auth sessions |
| `~/.belz/cache/methods/<uuid>.json` | AD method cache (5-minute TTL) |
| `~/.belz/cache/pages/<id>.json` | PD page/component cache |
| `~/.belz/migrations/jenkins-profiles.json` | Jenkins profile cache |
| `~/.belz/src/` | Repo checkout (created by the one-line installer) |

---

## Contributing

Each subtree has an `AGENTS.md` with conventions and "Maintainer Agent" guidance. Top-level conventions live in `AGENTS.md`.

Don't commit secrets. `~/.belz/config.json` is never read into the repo; the install script populates it locally.
