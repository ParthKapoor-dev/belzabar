# teamwork/commands

One folder per `wi-impl tw` command, each with `index.ts` (default `CommandModule` plus the
exported `args` spec), `help.txt` (the command's documentation) and `desc.txt` (its
`wi-impl --help-full` lines). Every folder is listed in [`../registry.ts`](../registry.ts).

| Folder | Command | Lib it uses |
|---|---|---|
| `add-comment/` | `wi-impl tw add-comment` | `addComment`; gated by `confirmWrite`, `writes = true` |
| `comments/` | `wi-impl tw comments` | `fetchComments` |
| `items/` | `wi-impl tw items` | `extractTicketItems` |
| `search/` | `wi-impl tw search` | `searchTasks` |
| `task/` | `wi-impl tw task` | `fetchTask` (includes all subtasks) |

The `<taskId|url>` positional is `TASK_ID_POSITIONAL` + `parseTaskId` from `lib/task-id.ts`, so
every command validates a task the same way.

`items/help.txt` documents the three dev-note comment shapes that item extraction recognises.

Commands return `ok(...)` or throw `CliError`; they never print or exit themselves. Adding a
command: see [`../AGENTS.md`](../AGENTS.md).
