# Teamwork — agent rules

Documentation: [`README.md`](README.md) (package, config, write safety),
[`lib/README.md`](lib/README.md), [`commands/README.md`](commands/README.md),
[`tests/README.md`](tests/README.md). Flag reference: each command's `help.txt` /
`wi-impl --help-full`.

## Standing instructions

- A change to behaviour, files or error codes updates the README at that level in the same
  commit; a flag change updates `help.txt` and `desc.txt` (`apps/cli/tests/args-docs.test.ts`
  fails on drift).
- `@belzabar/release` depends on `lib/items.ts` and `lib/task-id.ts`: run its tests too when
  changing either.

## Do not break

- Every Teamwork request goes through `teamworkFetch`; every Teamwork URL comes from
  `teamworkBase()` / `teamworkTaskUrl()`. No real company site in code, tests or docs.
- Paginated reads never return a truncated list: follow `hasMore` or fail.
- A write sets `writes = true` and is gated by core `confirmWrite`; an agent passes `--yes` only
  after the user approved the exact text.
- Task ids are validated only by `parseTaskId` (`INVALID_TASK_ID` before any request).
- `tw` stays in `NOT_ENV_AWARE_NAMESPACES`.
- Commands return `ok(...)` / throw `CliError`; they never print or exit.

## Adding a command

1. `commands/<cmd>/index.ts` (default `CommandModule`, exported `args` from core `defineArgs`),
   `help.txt`, `desc.txt`.
2. Register it in `registry.ts`, sorted (`apps/cli/tests/registry.test.ts` checks it).
3. Add its row to `commands/README.md` and the command table in `README.md`.
4. Tests in `tests/unit/` over `fakeFetch`; never against the live site.
