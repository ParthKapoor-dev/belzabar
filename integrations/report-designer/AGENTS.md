# Report Designer — agent rules

Documentation: [`README.md`](README.md) (what a report is, commands, spec, error codes),
[`lib/README.md`](lib/README.md) (routes and their side effects),
[`commands/README.md`](commands/README.md), [`tests/README.md`](tests/README.md).

## Do not break

- Every RD request goes through `lib/api.ts`. Read paths never use a route that runs the
  report (`apiInfoLevel=DETAILED`/`MEDIUM`, run, count, export) unless the command declares
  `writes` for that invocation (`--exact`, run, download).
- Specs carry no env-local ids: the datasource is `{category, method}`, resolved per env by
  `lib/datasource.ts`.
- Keep the package project-agnostic: no client names, hosts or report titles from a real env
  in code, docs or tests.

## Changing code safely

- Run `bun run check` from the repo root before every commit.
- A flag change updates `help.txt` and `desc.txt` (`apps/cli/tests/args-docs.test.ts`); a new
  command is a folder plus a sorted entry in `registry.ts` and a row in `commands/README.md`
  and the README command table.
- Wire behaviour changes go into `tests/unit/fake-rd.ts` together with the code. Live checks
  only on scratch reports you created; never save, archive or delete a report you did not
  create.
