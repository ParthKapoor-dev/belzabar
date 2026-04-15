---
name: belz-ai
description: Belzabar tooling primer + per-task workflow. ALWAYS load this skill at the start of any session in this directory — it explains what belz / AD / PD / Teamwork are and enforces the per-task subdirectory + TASK.md workflow. Also triggers on Teamwork URLs (projects.webintensive.com/app/tasks/...), task codes like NCNSS-XXX, "start task" / "new task", or any question about belz, AD chains, PD pages, NSM environments, or fetching task metadata.
---

# Belzabar Workflow Skill

You are working on **belzabar** — an internal developer toolset for the user's NSM platform team. This skill loads two things into context:

1. A **primer** on what belzabar is and how to think about its CLI (`belz`).
2. A **strict per-task workflow** for organizing scratch work in subdirectories with a `TASK.md` log.

This skill is **not** a command reference. For exact flags, always run `belz --help-full` or `belz <ns> <cmd> --help`. Never invent commands or flags from memory.

If the user's task involves NSM domain concepts (LT-260, LT-262, "Vehicle Sold", chain IDs, etc.), the **`nsm`** skill carries that knowledge. It is opt-in — the user invokes it with `/nsm` when they want that context loaded. If the user mentions an NSM concept and the `nsm` skill isn't loaded, say so rather than guess.

---

## Step 0 — Mandatory session bootstrap

Before doing anything else in a new session, run:

```bash
belz --help-full
```

This dumps the **complete, current** command reference (union of every `desc.txt` in the repo). It is the source of truth for what `belz` can do. Read it before suggesting any command. If `belz --help-full` fails (binary not installed, PATH issue), stop and tell the user — do not try to work around it.

Run this once per session, early. You don't need to re-run it unless the user says they just rebuilt `belz`.

---

## Part 1 — Belzabar Primer

### What belzabar is

Belzabar is the toolset the user's team uses to work on NSM (and similar Verifi-hosted apps). It ships three things; the CLI is the one that matters for daily work:

- **`belz` CLI** — unified binary, the source of truth for everything below.
- **Browser extension** — content script that enhances the AD/PD web UIs (e.g. `Ctrl+Shift+Enter` to run a test).
- **Web app** at `web/` — AI-driven session UI for pasting curl commands and managing agents.

The CLI wraps three otherwise-painful systems: Automation Designer, Page Designer, and Teamwork.

### Automation Designer (AD)

AD is the **backend** platform. Business logic lives there as **chains** of step-by-step services — think of a chain as a stored-procedure-as-a-graph.

Key vocabulary:

- **Method / chain** — one named unit (e.g. `LT260.submit`). Has a UUID ("published id"), inputs, and an ordered list of steps.
- **Step** — a single operation in the chain. Can be SQL, code (SpEL or JS), an HTTP call, or a sub-method invocation. Steps can have conditions, loops, and error handling.
- **Service category** — top-level grouping. Common ones for NSM: `NSM.Staff`, `NSM.Public`, `NSM.Helpers`, `NSM.Reporting`, `NSM.Templates`.
- **Published ID** — the UUID at the end of an AD URL like `https://nsm-dev.nc.verifi.dev/automation-designer/NSM.Staff/abc123def456`. This is what `belz ad show` and Dev Notes consume.

Daily AD operations (use `--help` for flags):

- `belz ad find` — search/list methods by name
- `belz ad show <uuid>` — fetch and display a method (`--full` for steps + services)
- `belz ad test <uuid>` — run a draft with a JSON input, get per-step trace
- `belz ad run <uuid>` — execute the published method live
- `belz ad sql tui` — interactive SQL session against AD's DB accounts

Methods are cached at `~/.belz/cache/methods/<uuid>.json` for 5 minutes — pass `--force` to bypass.

### Page Designer (PD)

PD is the **frontend** platform. Pages are configured as JSON: variables, derived expressions, HTTP service calls (which usually invoke AD methods), and a tree of components.

Key vocabulary:

- **Page** — a top-level container with its own hex ID. Maps to a route like `/ncdot-notice-and-storage/lt-260-submission`.
- **Component** — a reusable UI piece a page (or another component) embeds.
- **Variable** — page-level state. Can be user-defined or *derived* (computed from an expression).
- **HTTP call** — a service binding that hits an AD method endpoint.

Daily PD operations:

- `belz pd show <input>` — overview of a page or component. `<input>` accepts an app URL, a PD designer URL, a bare hex ID, or a component name.
- `belz pd show <input> --vars` / `--http` / `--components` / `--full`
- `belz pd find [query]` — search the page index (cached 7 days)
- `belz pd find-ad-methods <id> --recursive` — extract every AD method ID a page (and its component tree) depends on. Use this when a frontend bug is actually a backend one.
- `belz pd validate <input>` — run the 10 standard validation checks
- `belz pd analyze [PAGE_ID]` — recursive dependency + compliance analysis

### Teamwork

The team tracks work in Teamwork at `projects.webintensive.com`. The CLI:

- `belz tw task <id|url>` — fetch title, tags, status, workflow stage, description, comment count
- `belz tw comments <id|url>` — fetch comments

Auth is cookie-based, separate from the NSM Bearer-token flow. Sessions live at `~/.belz/sessions/teamwork.json`.

### Migrations and environments

- `belz migrate profiles` — list available migration profiles
- `belz migrate run --module AD --ids "id1,id2" --profile <name>` — promote chains/pages between environments
- `belz envs` — list environments (`nsm-dev`, `nsm-qa`, `nsm-uat`)

Default environment is `nsm-dev`. Override per-command with `--env nsm-qa` (etc.).

### The `--llm` flag

Every command takes `--llm` to emit a deterministic JSON envelope:

```json
{ "schema": "...", "version": "2.0", "ok": true, "command": "...", "data": {...}, "error": null, "meta": {} }
```

**Always pass `--llm` when you (the agent) invoke `belz` programmatically.** Human mode is for humans only — it produces tables that are noisy to parse.

### Where things live on disk

Everything under `~/.belz/`:

| Path | Contents |
|------|----------|
| `config.json` | Credentials (file wins over env vars) |
| `sessions/<env>.json` | Auth sessions per environment |
| `sessions/teamwork.json` | Teamwork cookie session |
| `cache/methods/<uuid>.json` | AD method cache (5-min TTL) |
| `cache/definitions/<id>.json` | AD chain body cache |
| `cache/method-finder/index-v1-<env>.json` | Method finder index (7-day TTL) |
| `migrations/nsm-profiles.json` | Migration profile cache |

### Companion skills

- **`tw-dev-note`** — generates standardized Dev Notes (NDNs) for Teamwork comments. Defer to it whenever the user says "NDN", "Dev Note", or asks to format finished AD/PD changes for handoff. Do **not** format Dev Notes by hand.
- **`nsm-context`** — domain knowledge for the NSM project (forms, statuses, chain IDs, lifecycle paths). Loads on NSM-related triggers.

### Hard rules for using `belz`

1. Never invent flags. Run `belz --help-full` or `belz <ns> <cmd> --help` first.
2. Always pass `--llm` when invoking from a tool call so output is parseable.
3. Don't memorize chain IDs, page IDs, or method names — fetch them with `belz` on demand.
4. Cached results may be up to 5 minutes stale. Pass `--force` if the user just edited a method.

---

## Part 2 — Per-Task Workflow

Follow this workflow exactly when doing any work in this directory. **Do not skip steps or improvise.**

There are two modes:

- **Task mode** — the user shared a Teamwork link or task code. Fetch metadata, create a `<CODE>/` subdir, populate `TASK.md`.
- **Ad-hoc mode** — the user just asked you to do something without a task reference. Create a named subdirectory under `general/` and work there.

### Step 1a — Task mode (user gave a TW link or task code)

Run:

```bash
belz tw task <url-or-id> --llm
```

Parse the JSON response. You're looking for:

- **`title`** — task name
- **`tags`** — array of tag strings; one of them is the project code in `<PROJECT>-<NUM>` format (e.g. `NCNSS-488`)
- **`status`** — current Teamwork status / workflow stage
- **`description`** — long-form task description (do **not** save this anywhere — fetch it again when needed)

If no tag matches `<PROJECT>-<NUM>`, ask the user what to name the directory. Do not invent a name in task mode.

Then create the task subdirectory:

```bash
mkdir <CODE>          # e.g. mkdir NCNSS-488
```

### Step 1b — Ad-hoc mode (no task reference)

If the user asks you to do work without mentioning a TW link, task code, or existing directory, you are in ad-hoc mode. Do not ask for a task — just:

1. Pick a **short, kebab-case, descriptive name** for what the user asked for (2–4 words). Examples:
   - "explain how LT262 aging works" → `lt262-aging-walkthrough`
   - "draft SQL to find orphan docs" → `orphan-docs-sql`
   - "poke at chain 1521" → `lt260-submit-inspection`
2. Create the directory under `general/`:
   ```bash
   mkdir -p general/<short-name>
   ```
3. Everything for this ad-hoc piece of work goes under `general/<short-name>/`.
4. Still create a `TASK.md` inside it (see Step 3), but use the ad-hoc template variant — the `TW` and `Status` fields become `N/A (ad-hoc)` and the summary is whatever the user asked you to do.

**Treat `general/<short-name>/` as the working root for the rest of the session**, exactly like a `<CODE>/` dir. Never write ad-hoc scratch files outside it.

### Step 2 — Scratch file discipline

**Every file you create for this task — scratch SQL, draft method JSON, screenshots, notes, anything — lives under the task/ad-hoc directory.** Never write scratch files directly in the parent (work-root) directory or in `general/` itself.

### Step 3 — Create `<CODE>/TASK.md`

**Task mode template.** Fill in the bracketed parts from the `belz tw task` response. Do not embellish.

```markdown
# <CODE> — <task title>

**TW:** <full url>
**Status:** <tw status>

## Summary
<1–3 sentence plain-English description of what needs to change. Distill from the TW description; do not paste it verbatim.>

## Impact
- **AD:** TBD
- **PD:** TBD
- **DB:** TBD

## Log
- <YYYY-MM-DD> — created task workspace
```

**Ad-hoc mode template.** Same structure; `TW` / `Status` become `N/A (ad-hoc)` and the summary is the user's ask in one or two sentences.

```markdown
# <short-name> — <1-line description>

**TW:** N/A (ad-hoc)
**Status:** N/A (ad-hoc)

## Summary
<what the user asked you to do, in their own terms>

## Impact
- **AD:** TBD
- **PD:** TBD
- **DB:** TBD

## Log
- <YYYY-MM-DD> — created ad-hoc workspace
```

### Step 4 — Work inside the task directory

Treat `<CODE>/` (task mode) or `general/<short-name>/` (ad-hoc mode) as the working root for the rest of the session. Any file you `Write` or `Edit` for this task is under that directory.

### Step 5 — Update the Log as you work

Append **one short bullet** to `## Log` whenever something meaningful happens:

- you identify the AD method or PD page involved
- you draft a fix (SQL, code, config change)
- you run a test and learn something
- you check off a sub-piece of the task

Format: `- <YYYY-MM-DD> — <one-line fact>`. No paragraphs. No narration of your thinking. No emojis. Today's date in ISO format.

### Step 6 — Update `## Impact` in place

As you discover the AD methods, PD pages, or DB tables involved, **edit** the `## Impact` section in place — replacing `TBD` with the specifics. Examples:

- `- **AD:** LT262.submit, LT262.archive`
- `- **PD:** /ncdot-notice-and-storage/lt-262-list`
- `- **DB:** application (added column is_archived)`

The Impact section should always reflect the **current** known scope, not a history.

### Step 7 — Handoff

When the task is done, the user will hand `TASK.md` to the `tw-dev-note` skill (or their own NDN process). Your job is to make sure the `## Impact` and `## Log` sections give that skill enough to work with: method names, page routes, DB changes, no fluff.

---

## Hard rules for the workflow

1. **Always** run `belz --help-full` once at the start of a session before suggesting any command.
2. **Never** create scratch files outside the active workspace dir (`<CODE>/` or `general/<short-name>/`).
3. **Never** write scratch files directly into `general/` itself — always under a named sub-folder.
4. **Never** dump the full TW description, comments, or AD method bodies into `TASK.md`. Fetch them on demand with `belz`.
5. **Never** write paragraphs in the Log. One line per real change.
6. **Never** invent a task code in task mode. If the tags don't yield one, ask.
7. In ad-hoc mode, you **must** pick the directory name yourself — do not ask the user to name it.
8. **Never** rename or restructure `TASK.md` away from one of the two templates.
9. The Log is a **changelog**, not a journal. If you can't summarize the change in one line, the change isn't done yet.
