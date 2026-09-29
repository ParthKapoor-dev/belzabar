# AGENTS.md — CLI (`apps/cli`)

## Purpose

`apps/cli/` is the **orchestration layer** for the `belz` binary. It owns:

- The entry point (`bin/cli.ts`, used both in dev and for the compiled binary)
- The wiring of every integration's command registry (`bin/options.ts`)
- Top-level commands (`cache`, `config`, `envs`, `extension`, `onboard`, `setup`, `update`)
- Install / reinstall scripts

Command implementations for `ad`, `pd`, `tw`, `migrate` and `release` live in the
`integrations/*` workspace packages (`@belzabar/ad`, `@belzabar/pd`, …); this app only wires
them together.

---

## Directory Map

```
apps/cli/
├── bin/
│   ├── cli.ts              Entry point: --help-full, then runNamespacedCli(buildCliOptions())
│   └── options.ts          Registries → runner options + `belz --help-full` text; REGISTRIES (for tests)
├── commands/
│   ├── registry.ts         Static, sorted registry of the top-level commands below
│   ├── cache/  config/  envs/  extension/  onboard/  setup/  update/
│   │                       each: index.ts + help.txt + desc.txt
├── tests/
│   ├── registry.test.ts           Every commands/*/ folder is registered, sorted, has help/desc
│   ├── write-commands.test.ts     D6: every remote-write command/sub-action declares writes (local: writesLocal)
│   ├── envelope-contract.test.ts  Every registered command's --llm envelope vs EnvelopeSchema
│   ├── compiled-pipe.test.ts      Compiles the binary to a tmp dir; >64 KiB --llm through a slow pipe
│   ├── update-paths.test.ts       `belz update` finds apps/cli/scripts (or the old cli/scripts)
│   ├── help-flags.test.ts, cache-command.test.ts
│   └── live/                      Opt-in live suites (BELZ_LIVE=sems-dev), skipped by default
├── scripts/
│   ├── install.sh / install.ps1   Build + install + first-run setup
│   ├── reinstall.sh               Wipe ~/.belz + fresh install (delegates to install.sh)
│   ├── record-install.mjs         Writes install metadata (sourceDir, …) for `belz update`
│   └── swap-binary.ps1            Windows deferred binary swap
├── package.json            Scripts: build, link. Depends on core + every integration package
└── tsconfig.json           Extends ../../tsconfig.base.json
```

---

## Registries and routing

Each integration exports a hand-maintained `registry` (`integrations/<x>/registry.ts`, exported as
`@belzabar/<pkg>/registry`): command name → `{ module, help, desc }`, with `help.txt`/`desc.txt`
imported `with { type: "text" }` so the compiled binary embeds them. There is no generator.

`bin/options.ts` builds the `runNamespacedCli` options:

```
belz ad | pd | tw | migrate | release <cmd>  → namespace commands from that registry
belz config / belz extension                 → passthrough namespaces (the module sub-routes)
belz cache | envs | onboard | setup | update → top-level commands
```

`belz cache` is itself a single top-level `CommandModule` that self-routes two subcommands via
core `defineSubcommands` (`{command: "belz cache", default: "invalidate"}`), the same pattern as
`config`/`extension`: `belz cache <uuid>...` / `--all --yes` (no literal subcommand keyword,
argv falls through to the `invalidate` default — a remote write, `writes: true`) and
`belz cache prune-local [--yes]` (local filesystem only: removes flat
`<namespace>/<key>.json` files left over from before caches were env-scoped — skipping
`method-finder`/`page-finder`, which are flat *by design*, see `UNSCOPED_NAMESPACES` in
`commands/cache/index.ts` — plus abandoned `.refresh/*.lock` files older than 10 minutes; default
dry run, `--yes` deletes; module declares `writesLocal: true` and `writes` is a function of the
parsed args so `prune-local` never demands an explicit `--env`). The reusable scan/delete core is
exported as `pruneLocalCache(cacheDir, {yes, now?, onError?})` for testing against a scratch dir.

`belz --help-full` = every `desc.txt`, in fixed section order, commands sorted (deterministic;
dev and compiled output are identical).

---

## Adding Commands

- **Top-level:** create `commands/<name>/{index.ts,help.txt,desc.txt}` and add the entry to
  `commands/registry.ts` (sorted). If it sub-routes itself like `config`, add it to `PASSTHROUGH`
  in `bin/options.ts`.
- **Integration command:** add the folder under `integrations/<x>/commands/` and the entry to
  `integrations/<x>/registry.ts` — see that module's AGENTS.md.
- **New namespace:** create the integration package (package.json, tsconfig, registry.ts), add it
  to `apps/cli/package.json` dependencies, `NAMESPACES` and `REGISTRIES` in `bin/options.ts`.

`tests/registry.test.ts` fails if a folder and its registry disagree.

---

## Build

```bash
bun run belz:build                     # from the repo root → apps/cli/belz
cd apps/cli && bun run build           # same
bun apps/cli/bin/cli.ts ad show --help # dev mode, no compile
bun run belz:install                   # apps/cli/scripts/install.sh (build + install + first-run)
```

---

## Tests

From the repo root: `bun run test` (all tests), `bun run typecheck` (root `tsconfig.json`, one
`tsc` program over every workspace), `bun run check` (both). CI: `.github/workflows/ci.yml`
(typecheck, then tests; both blocking — keep `tsc` at zero errors). The envelope contract test picks up new commands
automatically; add invocations that legitimately break the contract to its `KNOWN_VIOLATIONS`
only with a reason. Live: `BELZ_LIVE=sems-dev bun test apps/cli/tests/live`.

---

## Install Scripts

```bash
bash ./apps/cli/scripts/install.sh [--env-file <path>] [--install-dir <dir>]
bash ./apps/cli/scripts/reinstall.sh [--env-file <path>] [--install-dir <dir>] [--yes]
```

**`install.sh`** — `bun install --ignore-scripts`, compile `bin/cli.ts`, install the binary,
record install metadata, and on first install run `belz onboard` (or `belz setup --env-file`).

**`reinstall.sh`** — deletes `~/.belz/` and the binary, then delegates to `install.sh`.

Both compute `REPO_ROOT` three levels up (`$SCRIPT_DIR/../../..`). The root one-liners
(`install.sh`, `install.ps1`) and `belz update` use `apps/cli/scripts/`, falling back to the
pre-restructure `cli/scripts/` for one release.

---

## Help Text Standard

Every command must have a `help.txt` following the standard in
`integrations/automation-designer/AGENTS.md`, and a `desc.txt`: one line per invocation variant
(`<full invocation>  :->  <what it does>`). `desc.txt` feeds `belz --help-full`.

---

## Maintainer Agent Instructions

When you make a meaningful change to this directory — new commands, changed entry-point logic,
new scripts, structural changes — update this `AGENTS.md`, the registry, and `desc.txt`.
