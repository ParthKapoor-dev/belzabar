---
name: teamwork-api
description: Use the Teamwork project-management REST API directly over HTTP — no belz CLI required. Covers cookie auth, reading a task with all its metadata/assignees/tags/subtasks, reading comments, searching tasks, and posting a comment (write, confirmation-gated). Use when an agent needs to read or write Teamwork tickets on projects.webintensive.com but has no access to the `belz tw` commands.
---

# Skill: Teamwork API (raw HTTP)

This skill lets an agent talk to the Teamwork instance at
`https://projects.webintensive.com` **directly over HTTP**, without the `belz`
binary. It mirrors exactly what `belz tw task|comments|items|search|add-comment`
do under the hood — same endpoints, same query params, same response handling —
so the output is interchangeable.

Use it when you have credentials (or a live `tw-auth` cookie) and need to:
- **Read** a task's metadata, assignees, tags, subtasks, comment stats.
- **Read** all comments on a task, chronologically.
- **Search** tasks by keyword.
- **Extract** AD/PD/SQL release items from a ticket's text (see [Item extraction](#item-extraction)).
- **Post** a comment (a WRITE — read [Write safety](#write-safety-non-negotiable) first).

> **Base URL:** `https://projects.webintensive.com`
> **API root:** `/projects/api/v3` (JSON). Login is a separate `/launchpad/v1` endpoint.
> All examples below use `TW_BASE` for the base URL and `$TW` for the `tw-auth` cookie value.

---

## Authentication

Teamwork here uses **cookie-based** auth (not a Bearer token). You obtain a
`tw-auth` cookie once, then send it on every request as `Cookie: tw-auth=<value>`.

### 1. Credentials

You need an **email** and a **password**. If a `belz` config exists on the
machine (`~/.belz/config.json`), the password is stored **base64-encoded** under
`teamwork.password` and must be decoded before use:

```jsonc
// ~/.belz/config.json
{
  "teamwork": {
    "email": "you@belzabar.com",
    "password": "<base64-encoded-password>"   // atob() this before sending
  }
}
```

Environment fallbacks: `TEAMWORK_EMAIL`, `TEAMWORK_PASSWORD` (also base64).
The config file wins over env vars. If neither is present, you cannot
authenticate — stop and ask the user for credentials.

### 2. Login → get the `tw-auth` cookie

`POST /launchpad/v1/login.json` with a JSON body. The cookie comes back in the
`Set-Cookie` response header (there is **no** token in the JSON body).

```bash
# password must be the DECODED plaintext, not the base64 form
curl -sS -i -X POST "$TW_BASE/launchpad/v1/login.json" \
  -H "Content-Type: application/json;charset=utf-8" \
  -H "Accept: application/json, text/plain, */*" \
  -d '{"email":"you@belzabar.com","password":"<plaintext>","rememberMe":true}' \
  | grep -i '^set-cookie:'
# → set-cookie: tw-auth=XXXXXXXX; Path=/; ...
```

Extract the value with the regex `tw-auth=([^;]+)` from the `Set-Cookie`
header. In Bun/Node use `response.headers.getSetCookie()` (returns an array;
fall back to the single `set-cookie` header if empty). Cache the value —
sessions are reused across requests. The belz CLI stores it at
`~/.belz/sessions/teamwork.json` as `{"twAuth":"..."}`; you may read that file
directly if it exists and skip login entirely.

### 3. Every authenticated request

```
Accept: application/json
User-Agent: Bun/1.0 (Belzabar CLI)
Cookie: tw-auth=<value>
```

### 4. Handle 401 (expired cookie)

If any API call returns **401**, the cookie expired — re-run login, replace the
cookie, and retry the request **once**. Do not loop on repeated 401s; surface
the error instead.

---

## Reading a task

`GET /projects/api/v3/tasks/{taskId}.json` with a large `include` set. This is
the single most important call — it returns the task plus an `included` sidecar
of related entities (users, tags, tasklists, projects, stages, timeTotals) that
you resolve by ID.

**Query params (send all of these — this is the exact set the UI/CLI uses):**

```
include=taskListNames,tags,timeTotals,taskSequences,users.companies,companies,users,changeFollowers,commentFollowers,completeFollowers,teams,projects,tasklists,parentTasks,subtaskStats,projects.permissions,predecessors,cards.columns,workflows,workflows.stages,reminders,taskLists,projectNames
&getSubTasks=true
&checkForReminders=true
&includeRelatedTasks=true
&includeCommentStats=true
&includeCompletedPredecessors=true
```

```bash
INCLUDE="taskListNames,tags,timeTotals,taskSequences,users.companies,companies,users,changeFollowers,commentFollowers,completeFollowers,teams,projects,tasklists,parentTasks,subtaskStats,projects.permissions,predecessors,cards.columns,workflows,workflows.stages,reminders,taskLists,projectNames"
curl -sS "$TW_BASE/projects/api/v3/tasks/26917411.json?include=$INCLUDE&getSubTasks=true&checkForReminders=true&includeRelatedTasks=true&includeCommentStats=true&includeCompletedPredecessors=true" \
  -H "Accept: application/json" \
  -H "Cookie: tw-auth=$TW"
```

**Response shape (the fields that matter):**

```jsonc
{
  "task": {
    "id": 26917411,
    "name": "...",
    "description": "...",            // free text — parse for release items
    "status": "new|completed|...",
    "priority": "low|medium|high|null",
    "dueDate": "2026-07-01", "startDate": null,
    "createdAt": "...", "updatedAt": "...",
    "progress": 0,
    "estimateMinutes": 0,
    "parentTaskId": 0,                // 0 means "no parent"
    "tasklistId": 12345,
    "assigneeUserIds": [111, 222],    // resolve via included.users[id]
    "tagIds": [7, 8],                 // resolve via included.tags[id]
    "subTaskIds": [26917412, ...],    // ORDER matters; details NOT inline (see below)
    "workflowStages": [{ "stageId": 99 }],  // resolve via included.stages[id]
    "meta": { "commentStats": { "total": 12, "read": 12 } }
  },
  "included": {
    "users":     { "111": { "id":111, "firstName":"...", "lastName":"...", "email":"..." } },
    "tags":      { "7":   { "id":7, "name":"...", "color":"..." } },
    "tasklists": { "12345": { "id":12345, "name":"...", "projectId":6789 } },
    "projects":  { "6789": { "id":6789, "name":"..." } },
    "stages":    { "99":  { "id":99, "name":"..." } },
    "timeTotals":{ "26917411": { "loggedMinutes": 120 } }
  }
}
```

**Resolution rules:**
- **Assignees** ← `task.assigneeUserIds[]` → `included.users[uid]`. If a uid is
  missing from `included`, fall back to `{id: uid, firstName:"Unknown"}`.
- **Tags** ← `task.tagIds[]` → `included.tags[tid]`.
- **Parent name** ← `included.tasks[task.parentTaskId]?.name` (only if
  `parentTaskId` is truthy and `!== 0`).
- **Tasklist / project name** ← `included.tasklists[task.tasklistId].name`, then
  that tasklist's `.projectId` → `included.projects[projectId].name`.
- **Workflow stage** ← `task.workflowStages[0].stageId` → `included.stages[id].name`.
- **Time logged** ← `included.timeTotals[taskId].loggedMinutes`.
- **Comment stats** ← `task.meta.commentStats`.

### Subtasks need a second call

⚠️ The `/tasks/{id}.json` response gives you only `subTaskIds` (an ordered list
of IDs) — **not** the subtask details. To get names/status/etc, make a
follow-up call and then re-order the results to match the parent's
`subTaskIds` ordering:

`GET /projects/api/v3/tasks.json?parentTaskId={id}&includeCompletedTasks=true&pageSize=250`

```bash
curl -sS "$TW_BASE/projects/api/v3/tasks.json?parentTaskId=26917411&includeCompletedTasks=true&pageSize=250" \
  -H "Accept: application/json" -H "Cookie: tw-auth=$TW"
# → { "tasks": [ { "id", "name", "status", "priority", "progress", "dueDate", "assigneeUserIds":[] }, ... ] }
```

Build a `Map<id, task>` from `tasks[]`, then map the parent's `subTaskIds` over
it to preserve order. `assigneeCount = (assigneeUserIds ?? []).length`.

---

## Reading comments

`GET /projects/api/v3/tasks/{taskId}/comments.json`

```
include=users,teams,files
&orderBy=date
&orderMode=asc          // chronological, oldest first
&limit=500
```

```bash
curl -sS "$TW_BASE/projects/api/v3/tasks/26917411/comments.json?include=users,teams,files&orderBy=date&orderMode=asc&limit=500" \
  -H "Accept: application/json" -H "Cookie: tw-auth=$TW"
```

**Response:**

```jsonc
{
  "comments": [
    {
      "id": 555,
      "body": "plain text body",
      "htmlBody": "<p>...</p>",
      "postedByUserId": 111,
      "postedDateTime": "2026-06-30T14:22:00Z",
      "fileCount": 0
    }
  ],
  "included": { "users": { "111": { "firstName":"...", "lastName":"..." } } }
}
```

Author name ← `included.users[postedByUserId]` →
`` `${firstName} ${lastName}` ``, else `` `User#${postedByUserId}` ``.

---

## Searching tasks (read-only)

`GET /projects/api/v3/tasks.json` with `searchTerm`.

```
searchTerm=<query>
&include=tasklists,projects
&pageSize=25                       // default cap; raise for more
&projectIds=<id>                   // OPTIONAL — restrict to one project
&includeCompletedTasks=true        // OPTIONAL — default is open tasks only
```

```bash
curl -sS "$TW_BASE/projects/api/v3/tasks.json?searchTerm=vehicle+sold&include=tasklists,projects&pageSize=25" \
  -H "Accept: application/json" -H "Cookie: tw-auth=$TW"
```

**Response:** `{ "tasks": [...], "included": { "tasklists": {...}, "projects": {...} } }`.
For each task: `projectName` ← `included.tasklists[t.tasklistId].projectId` →
`included.projects[projectId].name`; `tasklistName` ←
`included.tasklists[t.tasklistId].name`. A clickable URL is
`` `${TW_BASE}/app/tasks/${t.id}` ``.

---

## Posting a comment (WRITE)

`POST /projects/api/v3/tasks/{taskId}/comments.json`

```jsonc
{
  "comment": {
    "body": "the comment text",
    "contentType": "TEXT"    // or "HTML"
  }
}
```

```bash
curl -sS -X POST "$TW_BASE/projects/api/v3/tasks/26917411/comments.json" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Cookie: tw-auth=$TW" \
  -d '{"comment":{"body":"Deployed to QA, ready for verification.","contentType":"TEXT"}}'
# → { "comment": { "id": 999 } }
```

The new comment id is at `response.comment.id`.

### Write safety (NON-NEGOTIABLE)

Posting a comment is a public, externally-visible action on a shared ticket.

- **Show the user the EXACT comment text** and get their explicit approval **in
  chat before every single POST.** A prior "go ahead" does **not** carry over to
  the next comment — re-show and re-confirm each time.
- Never invent, summarize, or "clean up" body text the user hasn't seen.
- Prefer `contentType: "TEXT"` unless the user asked for HTML.
- Log your intent before the call (what task, what body) so the action is
  auditable.

This mirrors the belz CLI's hard gate: its `add-comment` command **refuses in
`--llm` mode unless `--yes` is passed**, and `--yes` is only ever passed after
the exact text was validated with the user.

---

## Parsing a task ID from input

Users paste either a bare numeric id or a full URL. Accept both:

```
/tasks/(\d+)     → capture group 1 is the task id   (matches app URLs)
```

Otherwise `parseInt(input, 10)`; reject if `NaN`. Task URLs look like
`https://projects.webintensive.com/app/tasks/26917411`.

---

## Item extraction

When auditing a release, you often need to pull every AD chain, PD page/symbol,
and SQL statement referenced across a ticket's description + all comments + all
subtask comments. The belz `tw items` command does this; the recognition rules
are pure text patterns you can replicate:

**A. URLs**
- AD chain: `automation-designer/<Category>/<id>` where `<id>` is a 32-hex
  string or a dashed UUID.
- PD page: `ui-designer/page/<id>` — the hex here is the **DRAFT** id, never the
  deployable/published id.
- PD symbol: `ui-designer/symbol/<name>` (URL-decode the name).
- A `?version=<A>-<B>` query on a PD URL is a version range.

**B & C. Labeled CSV lists** (bare hex, not URLs), one per line:
- `PD Pages Published : <hex>,<hex>` → PD, kind `published`.
- `AD (Published Id): <hex>,<hex>` → AD.
- Heuristic: label containing `pd`/`page` ⇒ PD; `ad`/`method` ⇒ AD;
  `publish` in the label ⇒ published. Ambiguous (both or neither) ⇒ skip.

**SQL** (scan for a keyword up to the first `;`):
- **DDL → "DB" bucket:** `ALTER TABLE`, `CREATE TABLE`, `CREATE [UNIQUE] INDEX`,
  `DROP TABLE`, `DROP INDEX`, `TRUNCATE TABLE`.
- **DML → "Corrective fixes" bucket:** `INSERT INTO`, `UPDATE <t> SET`,
  `DELETE FROM`.

**Normalization:** lowercase and strip dashes from every hex id so
draft/published/URL forms of the same id dedupe to one key.

**Recommended set:** long tickets accumulate superseded ID lists from rewritten
approaches. Prefer the **latest** dev-note block (a comment carrying a labeled
list, or both AD+PD refs, or ≥2 refs of one kind), falling back per-type. Always
keep full provenance (which comment each ref came from) so the recommendation
can be audited. PD refs seen **only** as draft page URLs must be resolved to
their published ids before they can go into a release.

---

## Error handling checklist

| Symptom | Cause | Action |
|---|---|---|
| `401 Unauthorized` | expired/missing cookie | re-login, retry once |
| Login has no `tw-auth` in `Set-Cookie` | wrong creds / login shape changed | stop, report; don't retry blindly |
| `included.users[uid]` missing | user not in sidecar | fall back to `Unknown`/`User#<id>` |
| Subtasks empty but `subTaskIds` present | forgot the second `tasks.json?parentTaskId=` call | make it |
| Non-2xx on any read | permissions / bad id | surface status + body text |

## Endpoint quick reference

| Purpose | Method + path |
|---|---|
| Login | `POST /launchpad/v1/login.json` |
| Task + metadata | `GET /projects/api/v3/tasks/{id}.json?include=…` |
| Subtask details | `GET /projects/api/v3/tasks.json?parentTaskId={id}&includeCompletedTasks=true&pageSize=250` |
| Comments | `GET /projects/api/v3/tasks/{id}/comments.json?include=users,teams,files&orderBy=date&orderMode=asc&limit=500` |
| Search | `GET /projects/api/v3/tasks.json?searchTerm=…&include=tasklists,projects&pageSize=25` |
| Post comment (WRITE) | `POST /projects/api/v3/tasks/{id}/comments.json` |
| Web task URL | `https://projects.webintensive.com/app/tasks/{id}` |
