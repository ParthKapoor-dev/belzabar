# belz cloud sandbox

This is a **disposable runner repo** for Claude Code *cloud* sessions. It exists
only to hand a cloud session the `belz` CLI + skills so it can do belz work from
anywhere (e.g. your phone). **It is NOT a project, and its contents are
auto-generated** from the private `belzabar` repo by CI — never hand-edit them.

## Rules (read first)

- **Never commit, push, branch, or open a PR in this repo.** Nothing you produce
  here is a work product, and your changes would be overwritten on the next sync.
- **Do not treat the files here as a codebase to read, analyze, or refactor.**
  The only things you need from this repo are the skills in `.claude/skills/`.
- You do **not** have access to the `belzabar` source repository and you do not
  need it. Discover commands with `belz <area> --help`.
- Do the user's task entirely through the **`belz` CLI** (already on PATH) and
  the loaded skills, against the configured environments. Report results in chat.

## What you have

- `belz` on PATH — e.g. `belz --help`, `belz envs`, `belz ad ...`, `belz pd ...`,
  `belz migrate ...`, `belz tw ...`.
- Skills in `.claude/skills/`: `belz-ai` (load first — workflow + tooling), the
  domain skills (`nsm`, `ys`), and `tw-dev-note`.

## Start here

1. **Make sure belz is installed.** A SessionStart hook runs `cloud-setup.sh`
   automatically, but if `belz --version` fails, run it yourself first:
   `bash cloud-setup.sh` (idempotent — it installs belz and writes the config
   from the cloud environment variables, which are only visible in-session).
2. Load the **`belz-ai`** skill for workflow + tooling context.
3. Run **`belz envs`** to confirm which environments are configured.
4. Do what the user asked, using belz. Keep any scratch files in a task working
   directory (as `belz-ai` instructs) — never as commits in this repo.
