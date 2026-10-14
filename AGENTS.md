# AGENTS.md — Belzabar repository

You maintain this monorepo. What belz is, how to install and configure it, the workflows and the
repository map are in [`README.md`](./README.md); code docs are the README.md in each
directory. `belz --help-full` is the only command reference: never invent flags.

## Map

| Workspace | Agent rules |
|-----------|-------------|
| `apps/cli/` | [`apps/cli/AGENTS.md`](./apps/cli/AGENTS.md) |
| `packages/core/` | [`packages/core/AGENTS.md`](./packages/core/AGENTS.md) |
| `integrations/automation-designer/` | [`integrations/automation-designer/AGENTS.md`](./integrations/automation-designer/AGENTS.md) |
| `integrations/page-designer/` | [`integrations/page-designer/AGENTS.md`](./integrations/page-designer/AGENTS.md) |
| `integrations/report-designer/` | [`integrations/report-designer/AGENTS.md`](./integrations/report-designer/AGENTS.md) |
| `integrations/teamwork/` | [`integrations/teamwork/AGENTS.md`](./integrations/teamwork/AGENTS.md) |
| `integrations/migrations/` | [`integrations/migrations/AGENTS.md`](./integrations/migrations/AGENTS.md) (Jenkins client: [`lib/jenkins/README.md`](./integrations/migrations/lib/jenkins/README.md)) |
| `integrations/release/` | [`integrations/release/AGENTS.md`](./integrations/release/AGENTS.md) |
| `scripts/`, `cloud/` | Their README.md |

Read the workspace's `AGENTS.md` and the README of the directory you touch before changing it.

## Standing rules

- **Keep docs in step with code, in the same commit.** README.md is the documentation; AGENTS.md
  holds only agent working rules and links. Never duplicate content between them.
  - Every workspace root and every source, test and script directory has a README.md.
  - Command folders (`commands/<name>/`) have no README.md: their `help.txt` is the doc, and
    `desc.txt` (one line per invocation, `<full invocation>  :->  <what it does>`) feeds
    `belz --help-full`. Update both whenever a command's flags change.
  - Fixture directories are documented by their `manifest.json`, not a README.
  - `bun run docs:check` enforces the README rule, verifies every path and `belz` command in the
    docs, and keeps AGENTS.md files short.
- **Commands.** Implement `CommandModule` from `@belzabar/core`; declare arguments with
  `defineArgs` / `defineSubcommands` and export them as `args` (never hand-roll argv parsing);
  mark remote writes with `writes` (local-only writes with `writesLocal`). Adding or removing a
  command means its folder **and** its entry in the package's sorted `registry.ts`.
- **All user-facing UI goes through core's `ui` / `lifecycle` / `prompts`** (no other prompt or
  colour libraries); prompts refuse in `--llm` mode.
- **Packages import each other by package name** (`@belzabar/ad/lib/…`), never by `../../..`.
- **Project-agnostic.** No client or project names, hostnames, env URLs or ticket/stage ids in
  code, comments, tests or docs; use placeholders (`example.test`, `dev`, `qa`).
- **Never commit secrets.** Fixtures are captured only with `scripts/fixtures/capture.ts`
  (read-only, sanitized); the secrets test must stay green.
- **Never run** `bun run belz:install` / `belz:reinstall`, `belz update`, `belz setup` or
  `belz onboard` as part of a change, and never write to the real `~/.wi-impl`.
- **Before committing:** `bun run check` (typecheck, docs:check, dead-code, all tests) is green.
