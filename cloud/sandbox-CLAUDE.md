# belz cloud sandbox

This is a **disposable runner repo** for Claude Code *cloud* sessions. It exists
only to hand a cloud session the `belz` CLI so it can do belz work from
anywhere (e.g. your phone). **It is NOT a project, and its contents are
auto-generated** from the private `belzabar` repo by CI — never hand-edit them.

## Rules (read first)

- **Never commit, push, branch, or open a PR in this repo.** Nothing you produce
  here is a work product, and your changes would be overwritten on the next sync.
- **Do not treat the files here as a codebase to read, analyze, or refactor.**
  You need nothing from this repo beyond the `belz` binary it installs.
- You do **not** have access to the `belzabar` source repository and you do not
  need it. Discover commands with `belz <area> --help`.
- Do the user's task entirely through the **`belz` CLI** (already on PATH),
  against the configured environments. Report results in chat.

## What you have

- `belz` on PATH — e.g. `belz --help`, `belz envs`, `belz ad ...`, `belz pd ...`,
  `belz migrate ...`, `belz tw ...`. `belz --help-full` is the complete
  command reference.

## Start here

1. **Make sure belz is installed.** A SessionStart hook runs `cloud-setup.sh`
   automatically, but if `belz --version` fails, run it yourself first:
   `bash cloud-setup.sh` (idempotent — it installs belz and writes the config
   from the cloud environment variables, which are only visible in-session).
2. Run **`belz envs`** to confirm which environments are configured.
3. Do what the user asked, using belz. Keep any scratch files in a task working
   directory — never as commits in this repo.
