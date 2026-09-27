# Teamwork Module — Maintainer Agent Guide

## Purpose

The `teamwork/` module provides CLI commands for interacting with the Teamwork project management API at `projects.webintensive.com`. It is registered as the `tw` namespace in the unified `belz` binary.

## Command Routing

```
belz tw task <taskId|url>             → teamwork/commands/task/
belz tw comments <taskId|url>         → teamwork/commands/comments/
belz tw items <taskId|url>            → teamwork/commands/items/         (release-prep linker)
belz tw search <query>                → teamwork/commands/search/        (read-only task search)
belz tw add-comment <taskId|url> ...  → teamwork/commands/add-comment/   (WRITE — confirmation-gated)
```

## Directory Map

```
teamwork/
├── commands/
│   ├── task/             belz tw task — task metadata (subtasks via `fetchSubtasks`: pageSize=500 + page until hasMore=false; TW-11)
│   ├── comments/         belz tw comments — all comments (read; `fetchComments` paginates pageSize=500 + page until meta.page.hasMore=false — Teamwork ignores `limit`)
│   ├── items/            belz tw items — extract AD/PD/SQL release items
│   ├── search/           belz tw search — keyword task search (read)
│   └── add-comment/      belz tw add-comment — post a comment (WRITE, gated)
│       ├── index.ts      CommandModule implementation
│       ├── help.txt      Full help text
│       └── desc.txt      One-line descriptions for --help-full
├── lib/
│   ├── api.ts            Teamwork HTTP client + domain API functions
│   ├── auth.ts           Cookie-based authentication (tw-auth)
│   ├── confirm.ts        Confirmation gate + write-intent logging (for add-comment)
│   ├── extract.ts        Pure AD/PD/SQL extraction (release-prep Stage 2 patterns)
│   ├── items.ts          extractTicketItems — ticket → release items (used by `tw items` and `release matrix`)
│   ├── task-id.ts        parseTaskId + TASK_ID_POSITIONAL — the one `<taskId|url>` validator (INVALID_TASK_ID)
│   └── types.ts          Shared TypeScript types
├── registry.ts           Static, sorted command registry (@belzabar/teamwork/registry)
├── tests/unit/           bun test — extract, comment + subtask pagination, real comments, adapter, args
└── AGENTS.md             This file
```

## Tests and Fixtures

`tests/fixtures/real/` — sanitized real task + comment pages (task 25085246 captured
with pageSize=2 → 2 pages), `manifest.json`. Refresh (read-only) with
`bun scripts/fixtures/capture.ts tw <taskId> [pageSize]`. Used by `tests/unit/real-comments.test.ts`.

## Write Safety

`add-comment` is the only command that writes to Teamwork. It routes through
`lib/confirm.ts` → `requireConfirmation`, which prints the exact comment body
and prompts in human mode, and **refuses in `--llm` mode unless `--yes` is
passed**. The intent is that an agent only ever passes `--yes` after showing the
user the exact comment text and getting validation in chat — re-confirmed for
every post. A write is logged to stderr via `logIntent` before the POST.

## Authentication

Teamwork uses cookie-based auth, separate from the NSM Bearer token flow:
- Credentials: `~/.belz/config.json` under `teamwork` (`email`, `password`, `passwordEncoding`
  `"plain"`|`"base64"`; absent = legacy base64), read via `Config.getTeamwork()`; fallback
  env vars `BELZ_TEAMWORK_EMAIL` / `BELZ_TEAMWORK_PASSWORD` (plain)
- Session: `~/.belz/sessions/teamwork.json` (tw-auth cookie value, written atomically, 0600)
- HTTP: `teamworkFetch` runs on core `httpRequest` (timeout, IPv4 pin); single-flight login,
  401 → one shared re-login, 429 → bounded backoff (Retry-After), max 6 requests in flight.
  Non-OK → `teamworkError()` → `TW_NOT_FOUND` / `TW_HTTP_<status>`; auth → `TW_AUTH_*`
- Lists (comments, subtasks) are paginated to the end or fail (`TW_HTTP_*`,
  `TW_TOO_MANY_COMMENTS` / `TW_TOO_MANY_SUBTASKS` past 100 pages) — never a silently
  truncated list. A failed subtask listing fails `tw task` (it used to show "Unknown" rows).
- Auto-login on first request; auto-retry on 401

## Core Behavior Contract

1. Every command exports `schema`, `args` (a core `defineArgs` spec), `parseArgs` (built on
   `args.parse`: unknown flags, missing values and bad task ids are CliErrors), `execute`, and
   optionally `presentHuman`. `add-comment` also exports `writes = true`. Every flag in the spec
   must be documented in help.txt (checked by `apps/cli/tests/args-docs.test.ts`).
2. Commands **never** call `process.exit()` or print ad-hoc output.
3. All data flows through `ok(data)` / `CliError` — the runner handles envelopes.
4. `--llm` mode returns raw JSON envelopes; human mode uses `presentHuman()`.

## Adding a New Command

1. Create `teamwork/commands/<cmd>/` with `index.ts`, `help.txt`, `desc.txt`.
2. Add it to `registry.ts` (sorted); help/desc are embedded from there in dev and in the binary.
