# teamwork/tests/unit

| File | Covers |
|---|---|
| `adapter.test.ts` | `teamworkFetch`: login, single-flight re-login on 401, 429 backoff, concurrency cap, coded errors |
| `args.test.ts` | Argument parsing of every `belz tw` command, including `parseTaskId` |
| `comments-pagination.test.ts` | `fetchComments` follows `meta.page.hasMore` and refuses to truncate |
| `subtasks-pagination.test.ts` | `fetchSubtasks` follows `meta.page.hasMore` |
| `real-comments.test.ts` | `fetchComments` over the sanitized multi-page capture in `../fixtures/real/` |
| `extract.test.ts` | URL, labelled-list and SQL extraction; combined dev-note blocks |

`setTeamworkBackoffForTesting` (in `lib/api.ts`) replaces the 429 sleep so backoff tests run instantly.
