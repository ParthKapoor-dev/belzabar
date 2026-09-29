# Teamwork (`@belzabar/teamwork`) — Maintainer Guide

`belz tw …`: read tickets, comments and release items from Teamwork
(`projects.webintensive.com`), plus one confirmation-gated write (`add-comment`).
The lib is also used by `@belzabar/release` (`extractTicketItems`, `parseTaskId`).

## Commands

| Invocation | Kind | Notes |
|---|---|---|
| `belz tw task <taskId\|url>` | read | task + assignees, tags, status; subtasks paginated to the end |
| `belz tw comments <taskId\|url>` | read | every comment (paginated; Teamwork ignores `limit`) |
| `belz tw items <taskId\|url>` | read | release linker: AD/PD/SQL items from ticket + subtask comments |
| `belz tw search <query> [--project <id>] [--limit <n>] [--all]` | read | `--limit` 1–500 (default 25); `--all` = `--include-completed` |
| `belz tw add-comment <taskId\|url> --body <text>\|--body-file <path> [--html] [--yes]` | **write** | `writes = true`; confirmation-gated |

`belz --help-full` / each `help.txt` is the flag reference; `desc.txt` must list every variant.

## Layout

```
teamwork/
├── commands/<cmd>/{index.ts,help.txt,desc.txt}
├── lib/
│   ├── api.ts       teamworkFetch + fetchTask / fetchSubtasks / fetchComments / searchTasks / addComment
│   ├── auth.ts      cookie login (tw-auth), session file, single-flight re-login
│   ├── confirm.ts   requireConfirmation + logIntent (add-comment)
│   ├── extract.ts   pure AD/PD/SQL reference extraction from comment text
│   ├── items.ts     extractTicketItems — ticket → deduped items (tw items, release matrix)
│   ├── task-id.ts   parseTaskId + TASK_ID_POSITIONAL (the one `<taskId|url>` validator → INVALID_TASK_ID)
│   └── types.ts
├── registry.ts      static, sorted registry (`@belzabar/teamwork/registry`)
└── tests/           unit/*.test.ts, fixtures/real/
```

Package exports: `./registry`, `./lib/*`.

## Contracts

- **Not env-aware.** `tw` is in `NOT_ENV_AWARE_NAMESPACES` (`apps/cli/bin/options.ts`):
  envelopes carry no `meta.env` (Teamwork is a single host; `--env` is irrelevant). Because `writes` enforcement
  only applies to env-aware commands, `add-comment` is guarded by confirmation instead.
- **Write safety.** `add-comment` prints the exact body and prompts in human mode; with
  `--llm` it refuses (`TW_CONFIRMATION_REQUIRED`) unless `--yes`. Declining is
  `TW_USER_ABORT`. The intent is logged to stderr (`logIntent`) before the POST. An agent
  passes `--yes` only after the user approved the exact text.
- **Auth.** Credentials from `Config.getTeamwork()` (`~/.belz/config.json` → `teamwork`:
  `email`, `password`, `passwordEncoding`), falling back to trusted `BELZ_TEAMWORK_EMAIL` /
  `BELZ_TEAMWORK_PASSWORD`. Session cookie in `~/.belz/sessions/teamwork.json` (0600, atomic).
  Codes: `TW_AUTH_MISSING_CREDENTIALS`, `TW_AUTH_FAILED`, `TW_AUTH_NO_COOKIE`.
- **HTTP.** `teamworkFetch` runs on core `httpRequest` (timeout, IPv4 pin): single-flight
  login, one shared re-login on 401, bounded 429 backoff (Retry-After), ≤6 requests in
  flight. Non-OK → `TW_NOT_FOUND` / `TW_HTTP_<status>`.
- **No silent truncation.** Comments and subtasks page until `hasMore=false`, else fail
  (`TW_HTTP_*`, or `TW_TOO_MANY_COMMENTS` / `TW_TOO_MANY_SUBTASKS` past 100 pages). A failed
  subtask listing fails `tw task`.
- Commands export `schema`, `args` (core `defineArgs`), `parseArgs` (built on `args.parse`),
  `execute`, optional `presentHuman`; they return `ok(...)` / throw `CliError` and never print
  or exit themselves.

## Adding a command

1. `commands/<cmd>/index.ts` (export `args`; set `writes` if it mutates Teamwork and gate it
   through `lib/confirm.ts`), `help.txt`, `desc.txt`.
2. Add it to `registry.ts` (sorted). `apps/cli/tests/registry.test.ts` and
   `apps/cli/tests/args-docs.test.ts` check registration and help/desc ↔ spec drift.
3. Update this file.

## Testing

- `tests/unit/adapter.test.ts` — HTTP adapter over `fakeFetch` / `respond` /
  `withTempEnvConfig` from `@belzabar/core/testing` (login, 401, 429, errors).
- `tests/unit/real-comments.test.ts` — sanitized real task + two comment pages in
  `tests/fixtures/real/` (`manifest.json`). Refresh read-only with
  `bun scripts/fixtures/capture.ts tw <taskId> [pageSize]`.
- Also: `args.test.ts`, `extract.test.ts`, `comments-pagination.test.ts`,
  `subtasks-pagination.test.ts`.
