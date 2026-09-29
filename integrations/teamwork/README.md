# @belzabar/teamwork

`belz tw …` — read Teamwork tickets, comments and release items, search tasks, and post a
confirmed comment. The lib also backs `belz release matrix` (ticket → item linking).

## Role in the monorepo

- Depends only on `@belzabar/core` (config, http, args, confirmation, single-flight, limiter).
- `apps/cli` mounts [`registry.ts`](registry.ts) as the `tw` namespace.
- `@belzabar/release` imports `lib/items` (`extractTicketItems`), `lib/task-id` (`parseTaskId`)
  and, in tests, `lib/auth` (`saveTeamworkSession`); `scripts/fixtures/capture.ts` uses
  `lib/api` (`teamworkFetch`).
- `tw` is **not env-aware** (`NOT_ENV_AWARE_NAMESPACES` in `apps/cli/bin/options.ts`): Teamwork
  is one site, so envelopes carry no `meta.env` and `--env` is ignored.

| Directory | Contents |
|---|---|
| [`commands/`](commands/README.md) | One folder per `belz tw` command |
| [`lib/`](lib/README.md) | HTTP adapter, cookie auth, item extraction, task-id parsing, types |
| [`tests/`](tests/README.md) | Unit tests over a faked transport and sanitized Teamwork captures |

Exports: `@belzabar/teamwork/registry` and `@belzabar/teamwork/lib/<file>`. There is no barrel.

## Commands

| Command | Kind | What it does |
|---|---|---|
| `belz tw task <taskId\|url>` | read | Task, assignees, tags, status and every subtask |
| `belz tw comments <taskId\|url>` | read | Every comment of a task |
| `belz tw items <taskId\|url>` | read | AD / PD / SQL items referenced by the ticket and its subtasks' comments |
| `belz tw search <query>` | read | Task search (`--project`, `--limit` 1–500, `--all` for completed tasks) |
| `belz tw add-comment <taskId\|url>` | **write** | Posts `--body` / `--body-file` (`--html` for HTML) after confirmation |

A task is a positive number or a Teamwork task URL (`…/tasks/<id>`); anything else is
`INVALID_TASK_ID`. Flags and examples: each `commands/<cmd>/help.txt` or `belz --help-full`.

## Configuration

`Config.getTeamwork()` reads `~/.belz/config.json` → `teamwork`, falling back to trusted
environment variables:

| Key | Env fallback |
|---|---|
| `baseUrl` | `BELZ_TEAMWORK_URL` (no default; missing → `TW_CONFIG_MISSING`) |
| `email` | `BELZ_TEAMWORK_EMAIL` |
| `password` (+ `passwordEncoding`) | `BELZ_TEAMWORK_PASSWORD` |

Missing credentials fail `TW_AUTH_MISSING_CREDENTIALS`. The session cookie is kept in
`~/.belz/sessions/teamwork.json` (0600, written atomically).

## Write safety

`add-comment` declares `writes: true`, but since `tw` is not env-aware the runner's `--env` rule
does not apply; the command is gated by core `confirmWrite` instead. Human mode shows the exact
body and prompts; `--llm` without `--yes` fails `TW_CONFIRMATION_REQUIRED`; declining is
`TW_USER_ABORT`. The intent is logged to stderr (`logWriteIntent`) before the POST.

## Testing

```bash
bun test integrations/teamwork      # from the repo root; or `bun test` in this folder
```

See [`tests/README.md`](tests/README.md).
