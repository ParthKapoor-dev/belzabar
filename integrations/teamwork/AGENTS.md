# Teamwork Module — Maintainer Agent Guide

## Purpose

The `teamwork/` module provides CLI commands for interacting with the Teamwork project management API at `projects.webintensive.com`. It is registered as the `tw` namespace in the unified `belz` binary.

## Command Routing

```
belz tw task <taskId|url>      → teamwork/commands/task/
belz tw comments <taskId|url>  → teamwork/commands/comments/
belz tw items <taskId|url>     → teamwork/commands/items/   (release-prep linker)
belz tw search <query>         → teamwork/commands/search/
belz tw comment <taskId|url>   → teamwork/commands/comment/  (write — posts immediately)
```

## Directory Map

```
teamwork/
├── commands/
│   ├── task/             belz tw task — task metadata
│   ├── comments/         belz tw comments — all comments
│   ├── items/            belz tw items — extract AD/PD/SQL release items
│   ├── search/           belz tw search — search tasks by term
│   └── comment/          belz tw comment — post a comment (write)
│       ├── index.ts      CommandModule implementation
│       ├── help.txt      Full help text
│       └── desc.txt      One-line descriptions for --help-full
├── lib/
│   ├── api.ts            Teamwork HTTP client + domain API functions
│   ├── auth.ts           Cookie-based authentication (tw-auth)
│   ├── extract.ts        Pure AD/PD/SQL extraction (release-prep Stage 2 patterns)
│   └── types.ts          Shared TypeScript types
├── tests/unit/           bun test — extract.test.ts
└── AGENTS.md             This file
```

## Authentication

Teamwork uses cookie-based auth, separate from the NSM Bearer token flow:
- Credentials: `~/.belz/config.json` under `teamwork` key (email + base64-encoded password)
- Session: `~/.belz/sessions/teamwork.json` (tw-auth cookie value)
- Auto-login on first request; auto-retry on 401

## Core Behavior Contract

1. Every command exports `schema`, `parseArgs`, `execute`, and optionally `presentHuman`.
2. Commands **never** call `process.exit()` or print ad-hoc output.
3. All data flows through `ok(data)` / `CliError` — the runner handles envelopes.
4. `--llm` mode returns raw JSON envelopes; human mode uses `presentHuman()`.

## Write Safety (`belz tw comment`)

`comment` is the only write command. By design it has **no CLI confirmation
prompt** — it posts the moment it runs. The safeguard lives in the agent skills
(`belz-ai`, `tw-dev-note`): the exact comment text must be shown to the user and
explicitly validated **every time**, before the command is invoked. Do not add a
confirmation gate here without revisiting that decision.

## Adding a New Command

1. Create `teamwork/commands/<cmd>/` with `index.ts`, `help.txt`, `desc.txt`.
2. Run `bun run generate` from `cli/` to regenerate registries.
3. The command is automatically discovered in dev mode and embedded in prod builds.
