# Teamwork Module — Maintainer Agent Guide

## Purpose

The `teamwork/` module provides CLI commands for interacting with the Teamwork project management API at `projects.webintensive.com`. It is registered as the `tw` namespace in the unified `belz` binary.

## Command Routing

```
belz tw get-task <taskId|url>       → teamwork/commands/get-task/
belz tw get-comments <taskId|url>   → teamwork/commands/get-comments/
```

## Directory Map

```
teamwork/
├── commands/
│   ├── get-task/
│   │   ├── index.ts      CommandModule implementation
│   │   ├── help.txt      Full help text
│   │   └── desc.txt      One-line descriptions for --help-full
│   └── get-comments/
│       ├── index.ts
│       ├── help.txt
│       └── desc.txt
├── lib/
│   ├── api.ts            Teamwork HTTP client + domain API functions
│   ├── auth.ts           Cookie-based authentication (tw-auth)
│   └── types.ts          Shared TypeScript types
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

## Adding a New Command

1. Create `teamwork/commands/<cmd>/` with `index.ts`, `help.txt`, `desc.txt`.
2. Run `bun run generate` from `cli/` to regenerate registries.
3. The command is automatically discovered in dev mode and embedded in prod builds.
