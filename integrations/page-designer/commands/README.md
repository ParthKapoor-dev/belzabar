# `commands/`: the `belz pd` commands

One folder per command. Each command's `help.txt` is its full reference (flags, output,
notes); this page only indexes them and states the conventions they share.

## Commands

| Command | Writes | What it does |
|---|---|---|
| [`analyze`](./analyze/help.txt) | no | Recursive dependency tree (components, AD ids) from explicit roots; `--compliance` check |
| [`diff`](./diff/help.txt) | no | Structural diff of one page across two environments |
| [`find`](./find/help.txt) | no | Fuzzy search over the cached page/component index |
| [`find-ad-methods`](./find-ad-methods/help.txt) | no | AD method ids a page calls, optionally through its components |
| [`history`](./history/help.txt) | `restore` | Server version history: list, show, diff, restore into the draft |
| [`lock`](./lock/help.txt) | `acquire`, `release` | Manual lock control, recorded in `~/.wi-impl/pd-locks/<env>.json` |
| [`page-deps`](./page-deps/help.txt) | no | The page-dependencies graph summary |
| [`preflight`](./preflight/help.txt) | no | Dry run of `save`: resolve target, plan, validate |
| [`publish`](./publish/help.txt) | yes | Diff-aware validated, locked publish; `--host` deploys |
| [`save`](./save/help.txt) | yes | Validated, locked save of an overlay or full config into the draft |
| [`show`](./show/help.txt) | no | Overview and sections (vars, http, tree, find, …) |
| [`snapshot`](./snapshot/help.txt) | no | Normalized snapshot; `--compare` against a saved one |
| [`translations`](./translations/help.txt) | no | Release check of translation phrase keys |
| [`validate`](./validate/help.txt) | no | Every validator rule on a fresh read; `--recursive` |

## A command folder

- `index.ts`: `export const args = defineArgs({ command: "belz pd <name>", … })` and a default
  `CommandModule` whose `parseArgs` calls `args.parse(argv)`. Write commands set `writes`
  (`true`, or a function of the parsed args as in `history` and `lock`). The runner derives the
  envelope schema (`pd.<name>`); commands do not set it.
- `help.txt`: Usage, description, Arguments, Flags, Global Flags, Examples, Notes.
- `desc.txt`: one line per invocation variant, `belz pd <name> …  :->  what it does`.

## Conventions

- Reuse the flag fragments in [`../lib/args/common.ts`](../lib/args/common.ts). `--force` on a
  read command bypasses the cache; write commands never take `--force`.
- Talk to the server only through `pdApi` ([`../lib/api/`](../lib/api/README.md)) and import types
  from `lib/types/common.ts`, never `wire.ts`.
- Writes go through the pipeline in [`../lib/edit.ts`](../lib/edit.ts) and
  [`../lib/lock.ts`](../lib/lock.ts) (see [`../lib/README.md`](../lib/README.md#write-pipeline)).
- A failure that still has a report to show (validation, verify, compare) uses `failWithData` so
  the report stays in `data`.

## Adding a command

1. Create `<name>/index.ts`, `help.txt` and `desc.txt` as above.
2. Add it to [`../registry.ts`](../registry.ts), kept sorted (`apps/cli/tests/registry.test.ts`).
3. `apps/cli/tests/args-docs.test.ts` fails when `help.txt`/`desc.txt` drift from `args`.
4. Add a command-level test over the fake server
   ([`../tests/unit/helpers/`](../tests/unit/helpers/README.md)), and a row to the table above.
