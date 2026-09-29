# Release — agent rules

Documentation: [`README.md`](README.md) (package, spec, `matrix` / `freeze` flow, limitations),
[`lib/README.md`](lib/README.md) (env resolution, ledger), [`commands/README.md`](commands/README.md),
[`tests/README.md`](tests/README.md). Flag reference: each command's `help.txt` /
`belz --help-full`.

## Standing instructions

- A change to behaviour, files or error codes updates the README at that level in the same
  commit; a flag change updates `help.txt` and `desc.txt` (`apps/cli/tests/args-docs.test.ts`
  fails on drift).
- Reuse other integrations through their libs (`@belzabar/teamwork/lib/*`,
  `@belzabar/ad/lib/*`), never by calling another command's `execute()`.

## Do not break

- Every spec problem fails before the first network request.
- `matrix` traces AD items one at a time: `traceMethod` switches the global active env, so
  parallel traces would race.
- An excluded ticket contributes all its AD references; narrowing it can hide a collision.
- An incomplete link writes no ledger record, so `freeze` never snapshots a partial audit.
- Ledger writes stay atomic, and a corrupt file stays `LEDGER_CORRUPT`.
- `release` stays in `NOT_ENV_AWARE_NAMESPACES`; commands keep `writesLocal: true` and never
  write to a remote env.

## Adding a command

1. `commands/<cmd>/index.ts` (default `CommandModule`, exported `args` from core `defineArgs`),
   `help.txt`, `desc.txt`.
2. Register it in `registry.ts`, sorted (`apps/cli/tests/registry.test.ts` checks it).
3. Add its row to `commands/README.md` and the command table in `README.md`.
4. Tests in `tests/unit/` with faked transport.
