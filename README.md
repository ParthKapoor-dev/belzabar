# Belzabar

Developer toolset for engineers working on the **Expertly** low-code platform.
It ships **`belz`** — one CLI for Automation Designer (AD) methods, Page Designer (PD) pages,
Teamwork tickets, Jenkins DB migrations and release tracking. Every command has a
human view and a structured `--llm` JSON envelope for scripts and AI agents.

---

## Install

One line, anywhere (Linux/macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/ParthKapoor-dev/belzabar/main/install.sh | bash
```

Windows (PowerShell): `irm https://raw.githubusercontent.com/ParthKapoor-dev/belzabar/main/install.ps1 | iex`

The installer installs [`bun`](https://bun.sh) if missing, clones the repo into `~/.belz/src`,
builds the binary to `~/.local/bin/belz` (make sure that is on your `PATH`) and walks you
through credential setup the first time. **To update**, run `belz update` or re-run the
one-liner; credentials, sessions and caches are kept.

Non-interactive install: `… | bash -s -- --env-file ./belz.env --install-dir /opt/bin`.

From a clone (development):

```bash
git clone https://github.com/ParthKapoor-dev/belzabar.git && cd belzabar
bun install --ignore-scripts
bun run belz:install        # build + install the binary + first-run setup
bun run belz:reinstall      # wipe ~/.belz and the binary, then install fresh
```

---

## Configure

- `belz setup` (or `belz onboard` for the guided first run) adds or updates environments in
  `~/.belz/config.json` (mode 0600). It merges; `--replace --force` starts over.
- `belz envs` lists the configured environments and checks their auth; `belz config get`
  shows one env (never the token).
- There are no built-in environments: each env (name, base URL, credentials) comes from your
  config. Pick one per command with `--env <name>`. When omitted, belz uses `BELZ_ENV`, then
  `"defaultEnv"` in config.json (set it with `belz config edit`), then the only configured env.
  With several envs and no default, env-aware commands fail with `ENV_NOT_SELECTED`.
- **Commands that write to an environment require an explicit `--env`**, even for the default
  env, and ask for confirmation (pass `--yes` in scripts / `--llm` mode).
- belz reads only `BELZ_*` environment variables (`BELZ_ENV`, `BELZ_HOME`,
  `BELZ_HTTP_TIMEOUT_MS`, `BELZ_JENKINS_*`, `BELZ_TEAMWORK_*`, …) and ignores values that come
  from a `.env` file in the current directory.

Global flags: `--env <name>`, `--llm` (JSON envelope), `-v`/`--verbose`, `-h`/`--help`.
`belz --help-full` prints every command variant with a one-line description — it is the
complete command reference.

---

## Workflows

### Read an AD method

```bash
belz ad find "<words>"                 # search methods by name / alias / uuid
belz ad find --describe "<words>"      # "does a method for X exist?"
belz ad show <uuid>                    # structure + metadata (cached 5 min; --force for fresh)
belz ad show <uuid> --compact          # one line per step (conditions, loops, SQL/code, I/O)
belz ad show <uuid> --story            # plain-English Markdown summary for reviews
belz ad state <uuid>                   # draft/published linkage and whether they are in sync
belz ad callers <uuid>                 # who calls this method (add --pd for PD pages)
belz ad child-info <category> <method> --shape   # a callee's input/output contract
```

### Edit, validate, save and publish an AD method

Edits are small JSON **overlays** applied to the method's draft; belz fills in the platform
boilerplate. `belz ad save --help` documents the overlay keys (`parsedSteps[]` leaf edits and
`ops[]` such as `add-step`, `remove-step`, `move-step`, `update-step`, `set-input`).

```bash
belz ad validate <uuid>                                  # validator L1–L3 (add --online for L4)
belz ad lint <uuid>                                      # validator + SQL and anti-pattern review
belz ad save edit.json --uuid <uuid> --dry-run           # plan + validate, write nothing
belz ad save edit.json --uuid <uuid> --env dev      # save to the draft (confirms first)
belz ad save --uuid <uuid> --sql-file 3=step3.sql --env dev   # replace one step's SQL
belz ad publish <uuid> --note "fix totals" --env dev
```

Save refuses to overwrite a draft someone changed since it was read, re-reads the draft
afterwards to verify every change landed, and evicts the server's compiled cache. New methods:
`belz ad create --spec method.json --category <name> --env <env>` (same compact step format).

### Test an AD method

```bash
belz ad test <uuid> --env dev --inputs inputs.json --expect total=42
belz ad test <uuid> --env dev --inputs inputs.json --compare-published
belz ad test-case list <uuid>
belz ad test-case create <uuid> --name smoke --input id=1 --assert status=OK --env dev
belz ad test-case export <uuid> --dir ./tests      # git-friendly case files
belz ad test-case sync ./tests/<Category>/<method> --apply --env dev
belz ad sql run "select 1"                          # read-only SQL (writes: `sql update`/`insert`)
belz ad sql explain "select …" --analyze
```

`ad test` really executes the method, so it needs `--env`.

### Page Designer

```bash
belz pd show <page>                    # app/PD URL, id or exact name; --tree, --http, --vars
belz pd show <page> --find "<text>"    # locate a node (id + key path)
belz pd validate <page> --recursive    # exit 1 on validator errors
belz pd snapshot <page> --out base.json          # baseline …
belz pd snapshot <page> --compare base.json      # … exit 1 when the live page differs
belz pd preflight <pageId> --overlay edit.json   # dry-run an edit
belz pd save <pageId> --overlay edit.json --env <env>
belz pd publish <pageId> --env <env>
```

### Teamwork, migrations, releases

```bash
belz tw task <id>        belz tw comments <id>     belz tw search "<query>"
belz migrate profiles    belz migrate run --profile <profile> --module AD_Method --ids "<uuid>" --yes
belz migrate status <build>   belz migrate logs <build>
belz release matrix …    belz release freeze …   # see `belz release <cmd> --help`
```

### Caches

`belz cache --env <env> <uuid>` evicts a method from the server's compiled cache (a remote write, so `--env` is required).
`belz cache prune-local` cleans stale local cache files under `~/.belz/cache`.

---

## Claude Code cloud sessions

The `belz-cloud-release` workflow publishes the belz binary to a separate sandbox repo, so a
Claude Code cloud session can run belz without access to this repo. Setup and the network
allowlist: [`cloud/README.md`](./cloud/README.md).

---

## Repository map

A Bun workspaces monorepo (`packages/*`, `apps/*`, `integrations/*`; no build orchestrator).
Every workspace and every source, test and script directory has a README.md; start from these:

| Path | Package | Role |
|------|---------|------|
| [`apps/cli/`](./apps/cli/README.md) | `belzabar.cli` | The `belz` binary: entry point, registry wiring, top-level commands (`cache`, `config`, `envs`, `onboard`, `setup`, `update`), install scripts |
| [`packages/core/`](./packages/core/README.md) | `@belzabar/core` | Shared CLI framework: args, runner + `--llm` envelope, config, http, cache, ui, `platform` and `testing` subpaths |
| [`integrations/automation-designer/`](./integrations/automation-designer/README.md) | `@belzabar/ad` | `belz ad …` |
| [`integrations/page-designer/`](./integrations/page-designer/README.md) | `@belzabar/pd` | `belz pd …` |
| [`integrations/teamwork/`](./integrations/teamwork/README.md) | `@belzabar/teamwork` | `belz tw …` |
| [`integrations/migrations/`](./integrations/migrations/README.md) | `@belzabar/migrations` | `belz migrate …` (Jenkins client in `lib/jenkins/`) |
| [`integrations/release/`](./integrations/release/README.md) | `@belzabar/release` | `belz release …` (uses the AD and Teamwork libs) |
| [`scripts/`](./scripts/README.md) | — | `docs:check`, dead-code check, repo-wide tests, wire-fixture capture |
| [`cloud/`](./cloud/README.md) | — | Cloud-session bootstrap |

Integrations depend on `@belzabar/core` and on each other through package imports
(`@belzabar/release` → `@belzabar/ad/lib/…`), never through relative paths across packages.
Each exports `./registry` (its hand-maintained, sorted command registry) and `./lib/*`;
`apps/cli/bin/options.ts` wires the registries into `belz`.

**Runtime data** lives under `~/.belz/` (`BELZ_HOME` overrides it): `config.json` (0600),
`sessions/<env>.json` (0600), and `cache/` (method, definition, page and finder caches, scoped
per env).

Where the docs live:

- **Command reference:** `belz --help-full`, and `belz <ns> <cmd> --help` (each command's
  `help.txt` / `desc.txt`).
- **Code docs:** the README.md in each directory.
- **Agent rules:** `AGENTS.md` at the root and in each workspace (thin; they link here).

---

## Development

```bash
bun install --ignore-scripts
bun apps/cli/bin/cli.ts ad show <uuid>     # run from source, no build
bun run belz:build                         # compile the binary into apps/cli
bun run check                              # typecheck + docs:check + dead-code + all tests (CI runs this)
bun test integrations/automation-designer  # one package
BELZ_LIVE=<env> bun test apps/cli/tests/live    # opt-in live suite (read-only)
```

Tests never touch the real `~/.belz` (a preload points `BELZ_HOME` at a tmp dir). Committed
wire fixtures are sanitized, and `scripts/fixtures/fixtures-secrets.test.ts` fails on anything
that looks like a secret, personal data or a real hostname. Never commit `~/.belz/config.json`.
Adding a command: see `AGENTS.md`.
