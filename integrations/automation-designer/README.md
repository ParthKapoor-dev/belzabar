# @belzabar/ad — Automation Designer

The `belz ad` commands and the library behind them. It covers reading, editing,
validating, saving, publishing and testing Automation Designer methods. This
package has no entry point of its own: it is compiled into the `belz` binary
through `registry.ts`.

- Maintainer guide (layout, contracts, save pipeline, validator, testing): [AGENTS.md](./AGENTS.md)
- Wire and platform notes: [docs/api-notes.md](./docs/api-notes.md)
- Command reference: `belz ad <cmd> --help`, or `belz --help-full` for every command

## Typical loop

```bash
belz ad find "order list"                      # locate a method (cached index)
belz ad show <uuid> --compact                  # read it, one line per step
belz ad lint <uuid>                            # review it
belz ad save edit.json --uuid <uuid> --dry-run # plan + validate an overlay; writes nothing
belz ad save edit.json --uuid <uuid> --env <env>
belz ad test <uuid> --env <env> --inputs in.json --expect out=42
belz ad publish <uuid> --note "why" --env <env>
```

Add `--llm` to any command to get a structured JSON envelope. Write commands need an
explicit `--env`. They ask for confirmation, and in `--llm` mode they need `--yes`
instead.
