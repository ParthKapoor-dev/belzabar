# AGENTS.md — Belzabar Repository

## You Are the Maintainer Agent

You are working inside the **Belzabar** monorepo. Your role is to understand, extend, and
maintain this codebase. Before making changes in any module, read that module's `AGENTS.md`.

**Standing instruction:** Whenever you make a meaningful change to any module — new commands,
changed behavior, new files, API changes, structural reorganization — you **must** update the
`AGENTS.md` in that module. If the overall repository structure changes, update this root
`AGENTS.md` as well. If you add, remove, or change flags on any command, update that command's
`help.txt` and `desc.txt` — `desc.txt` is what `belz --help-full` outputs and what runtime agents
use as their command reference. `bun run docs:check` fails when a doc names a path or a
`belz` command that does not exist.

---

## What Is Belzabar

Belzabar is an internal developer toolset for the **Expertly** low-code platform:

- **Automation Designer (AD)** — backend logic as versioned "methods" (chains of steps)
- **Page Designer (PD)** — frontend pages/components as JSON configurations

plus **Teamwork** (ticket tracker), Jenkins-backed DB **migrations**, and **release**
promotion tracking. It ships two products:

1. **`belz` CLI** — one binary for all of the above
2. **Browser extension** — content scripts + a DevTools panel that enhance the AD/PD web UIs

---

## Repository Layout

| Directory | Package | Role | Docs |
|-----------|---------|------|------|
| `apps/cli/` | `belzabar.cli` | The `belz` binary: entry point, top-level commands, install scripts | `apps/cli/AGENTS.md` |
| `apps/extension/` | `belzabar-extension` | Browser extension (MV3, JavaScript) | `apps/extension/AGENTS.md` |
| `packages/core/` | `@belzabar/core` | Shared CLI framework (args, runner, envelope, config, http/auth, cache, ui, testing) | `packages/core/AGENTS.md` |
| `packages/design/` | `@belzabar/design` | Design tokens shared by the CLI and the extension | — |
| `integrations/automation-designer/` | `@belzabar/ad` | `belz ad` commands + lib | `integrations/automation-designer/AGENTS.md` |
| `integrations/page-designer/` | `@belzabar/pd` | `belz pd` commands + lib | `integrations/page-designer/AGENTS.md` |
| `integrations/teamwork/` | `@belzabar/teamwork` | `belz tw` commands + lib | `integrations/teamwork/AGENTS.md` |
| `integrations/migrations/` | `@belzabar/migrations` | `belz migrate` commands + lib (Jenkins-backed) | `integrations/migrations/AGENTS.md` |
| `integrations/release/` | `@belzabar/release` | `belz release` commands (uses the AD/TW libs) | `integrations/release/AGENTS.md` |
| `integrations/jenkins/` | `@belzabar/jenkins` | Jenkins REST client used by migrations | `integrations/jenkins/AGENTS.md` |
| `scripts/` | — | `docs-check.ts` (docs gate) and `fixtures/` (read-only wire-fixture capture + sanitizer) | — |
| `cloud/` | — | Claude Code cloud-session bootstrap (publish + sandbox files) | `cloud/README.md` |
| `agents/` | — | Runtime agent skills (published to cloud sessions); not part of the build | — |
| `.github/workflows/` | — | `ci.yml` (typecheck, docs check, tests), `belz-cloud-release.yml`, `extension-release.yml` | — |

`expertly.coding.agents/`, if present locally, is a separate git checkout ignored by
`.gitignore`; it is not part of this repo.

---

## Monorepo Structure

A **Bun workspaces** monorepo (no Turborepo). Root `package.json` workspaces:
`packages/*`, `apps/*`, `integrations/*`. Every workspace has its own `package.json` and a
`tsconfig.json` extending the root `tsconfig.base.json`; the root `tsconfig.json` is one `tsc`
program over all of them.

- Integrations depend on `@belzabar/core` and on each other through package imports
  (e.g. `@belzabar/release` → `@belzabar/ad/lib/trace`); never through `../../..` paths.
- Integration packages export `./registry` (their static command registry) and `./lib/*`.
- `apps/cli` depends on every integration and wires their registries together.

Root scripts:

| Script | Does |
|--------|------|
| `bun run check` | `typecheck` + `docs:check` + `test` — must be green before every commit |
| `bun run typecheck` | `tsc --noEmit` over every workspace |
| `bun run docs:check` | `scripts/docs-check.ts`: every repo path and `belz <cmd>` named in an `AGENTS.md`/`README.md` must exist |
| `bun run test` | `bun test` (unit, contract, compiled-binary pipe tests; live suites skipped) |
| `bun run build` | `bun run --filter '*' build` |
| `bun run belz:build` / `belz:install` / `belz:reinstall` | Build / install / wipe-and-reinstall the binary (`apps/cli/scripts/`) |

---

## How `belz` Routes Commands

```
belz ad <cmd>      → integrations/automation-designer/commands/<cmd>/
belz pd <cmd>      → integrations/page-designer/commands/<cmd>/
belz tw <cmd>      → integrations/teamwork/commands/<cmd>/
belz migrate <cmd> → integrations/migrations/commands/<cmd>/
belz release <cmd> → integrations/release/commands/<cmd>/
belz config …      → apps/cli/commands/config/     (passthrough: does its own sub-routing)
belz extension …   → apps/cli/commands/extension/  (passthrough)
belz cache | envs | setup | onboard | update → apps/cli/commands/<cmd>/
```

Each integration lists its commands in a hand-maintained, sorted `registry.ts` (top-level:
`apps/cli/commands/registry.ts`). `apps/cli/bin/options.ts` turns the registries into the runner
options and `belz --help-full` (fixed namespace order, commands sorted, byte-deterministic);
`apps/cli/bin/cli.ts` is the single entry point (dev and compiled). Routing itself is
`packages/core/src/runner.ts` (`runNamespacedCli`).

**Environments:** built in are `nsm-dev`, `nsm-qa`, `nsm-uat`; more come from `~/.belz/config.json`
(e.g. `sems-dev`). The default env is `BELZ_ENV` > config `defaultEnv` > `nsm-dev`.

---

## Key Contracts

- **Commands** implement `CommandModule` from `@belzabar/core`: `parseArgs` + `execute` +
  optional `presentHuman`. Results are `ok(data)` / `fail(message)` or `throw new CliError(message, { code })`.
- **Arguments** are declared with `defineArgs` / `defineSubcommands` (`packages/core/src/args/`)
  and exported from the command's `index.ts` as `args`; `parseArgs` calls `args.parse(argv)`.
  Never hand-roll argv parsing. Bad input fails with stable codes (`UNKNOWN_FLAG`,
  `MISSING_VALUE`, `INVALID_VALUE`, …).
- **`--llm` envelope** (`packages/core/src/envelope.ts`, v`2.0`):
  `{ schema: "<ns>.<cmd>", version, ok, command, data, error: { code, message, details? } | null, meta: { durationMs, env?, warnings? } }`.
  `ok` ⇔ exit code 0; `error.code` is UPPER_SNAKE. `apps/cli/tests/envelope-contract.test.ts`
  checks every command against the schema.
- **Writes**: a command that writes to a remote env sets `writes: true` (or a function of the
  parsed args). The runner then refuses to run it without an explicit `--env`
  (`ENV_REQUIRED_FOR_WRITE`) and names the target env in human mode. Prompts refuse in `--llm`
  mode, so destructive commands take `--yes`.
- **UI**: all user-facing output goes through `@belzabar/core`'s `ui` module (prompts, spinners,
  tables, `log.*`). Never use `inquirer`, `chalk`, or hand-rolled readline selectors.
- **Config & env vars**: belz reads only `BELZ_*` variables (and ignores values injected from a
  cwd `.env*` file). Useful ones: `BELZ_HOME`, `BELZ_ENV`, `BELZ_VERBOSE`,
  `BELZ_HTTP_TIMEOUT_MS`, `BELZ_HTTP_WRITE_TIMEOUT_MS`, `BELZ_LIVE` (tests).

---

## Runtime Data

Everything lives under `~/.belz/` (`BELZ_HOME` overrides it; tests set a temp one via the
`bunfig.toml` preload):

| Path | Contents |
|------|----------|
| `~/.belz/config.json` | Credentials per env, `defaultEnv`, Jenkins/Teamwork config (0600, zod-validated; passwords carry `passwordEncoding`) |
| `~/.belz/sessions/<env>.json` | Saved auth sessions per environment (0600) |
| `~/.belz/cache/<kind>/<env>/…` | Local caches (AD `methods`, `definitions`, `callers`, …; PD `pages`, …) |
| `~/.belz/pd-locks/<env>.json` | PD edit locks held by this machine |
| `~/.belz/migrations/jenkins-profiles.json` | Jenkins migration profile cache |
| `~/.belz/promotion/` | Local release-promotion ledger |

Core `Cache` namespaces every entry by env by default (`envScoped: false` opts out).
`belz cache prune-local` removes stale pre-env-scope entries and abandoned refresh locks.

---

## Adding a Command

1. Create `commands/<cmd>/` in the owning module with `index.ts` (exports `args` and a default
   `CommandModule`), `help.txt` (template in `integrations/automation-designer/AGENTS.md`) and
   `desc.txt` (one line per invocation variant: `<full invocation>  :->  <what it does>`).
2. Add it to that module's `registry.ts`, keeping it sorted.
3. Add a contract test (fakeFetch + the module's `tests/fixtures/`).
4. Update the module's `AGENTS.md`, then run `bun run check`.

Guards: `apps/cli/tests/registry.test.ts` (folders ⇔ registry), `apps/cli/tests/args-docs.test.ts`
(help.txt/desc.txt ⇔ `args` spec), `apps/cli/tests/write-commands.test.ts` (writes declared),
`apps/cli/tests/help-full.test.ts` (`--help-full` deterministic).

---

## Testing

- `bun run test` runs everything offline. HTTP is faked with `fakeFetch` and the other helpers in
  `@belzabar/core/testing` (`packages/core/src/testing/`), fed by sanitized real responses in each
  module's `tests/fixtures/`.
- **Wire fixtures**: `scripts/fixtures/capture.ts` captures real API responses (with
  `manifest.json`). It is **read-only** (GET only) and **sems-dev only**, and runs every body
  through `scripts/fixtures/sanitize.ts`. `scripts/fixtures/fixtures-secrets.test.ts` fails on
  anything that looks like a secret or PII — re-run
  `bun scripts/fixtures/capture.ts resanitize <dir>` if it trips.
- **Live suites** are opt-in: `BELZ_LIVE=sems-dev bun test apps/cli/tests/live` (read-only), plus
  `BELZ_LIVE_WRITE=1` for write suites (AD category Test-Parth only, `belz_tst_` names). Any other
  `BELZ_LIVE` value is refused. CI never sets it.

---

## Where to Start

- AD command? `integrations/automation-designer/AGENTS.md`
- PD command? `integrations/page-designer/AGENTS.md`
- CLI entry point, build, install, top-level commands? `apps/cli/AGENTS.md`
- Framework (runner, args, envelope, http, cache, testing)? `packages/core/AGENTS.md`
- Teamwork / migrations / release / Jenkins? `integrations/teamwork/AGENTS.md`,
  `integrations/migrations/AGENTS.md`, `integrations/release/AGENTS.md`, `integrations/jenkins/AGENTS.md`
- Browser extension? `apps/extension/AGENTS.md`
- Human-facing overview and workflows: `README.md`
