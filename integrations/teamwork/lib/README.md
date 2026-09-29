# teamwork/lib

Teamwork client and ticket parsing, imported as `@belzabar/teamwork/lib/<file>`.

| File | Contents |
|---|---|
| `api.ts` | `teamworkFetch` (the one HTTP entry point) and the endpoints: `fetchTask`, `fetchSubtasks`, `fetchComments`, `searchTasks`, `addComment`; `TEAMWORK_CONCURRENCY`; `setTeamworkBackoffForTesting` |
| `auth.ts` | `teamworkBase` / `teamworkTaskUrl` (the only source of Teamwork URLs), cookie login, session file, `ensureTeamworkAuth` / `refreshTeamworkAuth`, `saveTeamworkSession` |
| `extract.ts` | Pure extraction of AD / PD / SQL references from one text blob (`extractFromText`, `extractSql`, `normalizeHex`) |
| `items.ts` | `extractTicketItems` — ticket + subtask comments → deduped items with provenance and a recommended set |
| `task-id.ts` | `parseTaskId` (`INVALID_TASK_ID`), `TASK_ID_POSITIONAL` |
| `types.ts` | Session, task, subtask, comment, search-result and add-comment shapes |

## HTTP (`api.ts`, `auth.ts`)

- Every request runs on core `httpRequest` (timeout, IPv4 pin) with the `tw-auth` cookie.
- Login is single-flight: concurrent callers share one login; a 401 triggers one shared
  re-login and a retry (`TW_AUTH_FAILED`, `TW_AUTH_NO_COOKIE` on failure).
- A 429 is retried up to 4 times, honouring `Retry-After` (backoff capped at 15 s), when the
  body can be replayed.
- At most `TEAMWORK_CONCURRENCY` (6) requests are in flight; `release matrix` fans out.
- Non-OK responses map to `TW_NOT_FOUND` (404) or `TW_HTTP_<status>` via core `httpError`.

## No silent truncation

Teamwork ignores `limit` on comments, so `fetchComments` and `fetchSubtasks` page until
`meta.page.hasMore` is false. A page error fails the whole call, and more than 100 pages fails
`TW_TOO_MANY_COMMENTS` / `TW_TOO_MANY_SUBTASKS`. `fetchTask` fetches every subtask, so a failed
subtask listing fails `tw task`.

## Item extraction (`extract.ts`, `items.ts`)

`extract.ts` recognises three dev-note shapes (documented for users in
`commands/items/help.txt`): platform URLs (AD method, PD page, PD symbol), and labelled hex
lists for PD and AD ids. Ids are normalised (lowercase, no dashes); a PD page URL yields a
draft id. SQL statements are split into DDL (`db`) and DML (`corrective`); this is heuristic.

`items.ts` scans the description, every comment and every subtask's comments oldest-first,
merges references with their occurrences, and picks `recommended` from the latest dev-note
block (a comment with a labelled list, both AD and PD refs, or several refs of one kind).
Doubtful results (no dev-note block, no references at all, …) are reported in `warnings`;
fetch errors still fail.

## Extending

- New endpoint: a function in `api.ts` on `teamworkFetch` + `teamworkError`, a shape in
  `types.ts`, a `fakeFetch` test in `../tests/unit/`.
- New reference shape: a pure matcher in `extract.ts` with a case in `extract.test.ts`.
