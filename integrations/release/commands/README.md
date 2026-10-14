# release/commands

One folder per `wi-impl release` command, each with `index.ts` (default `CommandModule` plus the
exported `args` spec), `help.txt` (the command's documentation) and `desc.txt` (its
`wi-impl --help-full` lines). Every folder is listed in [`../registry.ts`](../registry.ts).

| Folder | Command | Notes |
|---|---|---|
| `freeze/` | `wi-impl release freeze <release-name> [--force]` | Reads the ledger record, writes a prod snapshot |
| `matrix/` | `wi-impl release matrix <release.json>` | Link → trace → collisions/leaks → ledger; exports `classifyLeak` and `MatrixData` for tests |

Both set `writesLocal: true`. The flow of each command is described in the package
[README](../README.md); spec and ledger rules in [`../lib/README.md`](../lib/README.md).

Adding a command: see [`../AGENTS.md`](../AGENTS.md).
