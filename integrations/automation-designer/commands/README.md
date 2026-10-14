# commands — the `wi-impl ad` commands

One folder per command: `index.ts` (the exported `args` spec and the `CommandModule`),
`help.txt` (the full reference, printed by `wi-impl ad <cmd> --help`) and `desc.txt` (one line per
invocation variant, collected into `wi-impl --help-full`). The folders are listed in
[`../registry.ts`](../registry.ts). The help.txt of each command is its documentation; this page
is only the map.

## Commands

Read-only unless marked **W**. A write sets `writes`, so `--env` must be given explicitly, and it
asks for confirmation (in `--llm` mode it needs `--yes` instead).

| Command | What it does |
|---|---|
| `find [list\|pick\|<query>]` | Search the cached method index; category counts; fzf picker. |
| `grep <regex>` | Regex search over method step text: SQL, custom code, SpEL, input values (read-only). |
| `fetch`, `show`, `show-code` | Read a method (`--v2` to read through V2). `show --compact` / `--story` are the agent views; `show <file>` shows a local body. |
| `outputs`, `state` | The I/O contract plus what each step writes; draft/published linkage and `inSync`. |
| `categories`, `category create` | List categories; **W** create one. |
| `services`, `child-info` | The service catalog or one service's methods; a callee's contract (`--shape`). |
| `callers` | Which AD methods (and PD pages/components with `--pd`) call a method. |
| `export`, `export-category`, `import` | Export JSON; **W** import (refuses published records and validator errors). |
| `history list\|show\|diff\|restore`, `diff`, `trace` | Version history (**W** `restore`), history or cross-env diff, where a method is on every env. |
| `validate`, `lint` | The validator (L1–L3, `--online` L4) and advisory review rules, on a uuid or a local file. |
| `save`, `create`, `delete`, `publish`, `changelog` | **W** the write pipeline ([`../lib/save/README.md`](../lib/save/README.md)); `changelog` lists notes and writes one with `--note`. |
| `test`, `run`, `run-suites`, `save-suite` | **W** execute a method (inline test, live execute, local suites); `save-suite` writes a local suite file. |
| `test-case`, `test-cases`, `test-report` | Persisted test cases (`list`, `export` and `sync` without `--apply` are reads; the rest **W**); the suite summary; the global suite report. |
| `sql dbs\|run\|explain` | Read-only SQL. |
| `sql update\|insert\|modify\|tui` | **W** SQL writes. |

## help.txt template

```
Usage: wi-impl ad <cmd> <REQUIRED_ARG> [OPTIONAL_ARG] [flags]

One-sentence description of what the command does.

Arguments:
  <REQUIRED_ARG>        Description.
  [OPTIONAL_ARG]        Description. Defaults to X if omitted.

Flags:
  --flag-name <VALUE>   Description. (default: X)
  --bool-flag           Description.
  --help, -h            Show this help message.

Global Flags:
  --env <name>          Set active environment. (default: WI_IMPL_ENV, else defaultEnv,
                        else the only env)
  --llm                 Output structured JSON envelope for scripting/LLM use.

Examples:
  wi-impl ad <cmd> <example1>
  wi-impl ad <cmd> <example2> --flag
```

- Required positionals are uppercase in `<>`; optional ones in `[]`.
- Flag descriptions are aligned in one column and end with `(required)` or `(default: X)` where
  that applies. `--help, -h` is the last Flags entry.
- Always include Global Flags; write commands say that `--env` is required.
- Extra sections (Notes, Errors, Data, Rules) go before Examples. Give 2–3 real examples.
- `desc.txt`: one line per invocation variant, `wi-impl ad <cmd> <args> --flag  :->  what it does`.

`apps/cli/tests/args-docs.test.ts` fails when help.txt or desc.txt mention a flag the spec does
not have, or miss one it does. `apps/cli/tests/registry.test.ts` fails when the folders and
`registry.ts` disagree.

## Adding a command

1. `commands/<name>/index.ts`: export `args` from core `defineArgs` / `defineSubcommands`
   (spread `AD_YES_FLAG` for writes, `AD_V2_FLAG` only when it fetches a method; see
   [`../lib/args/README.md`](../lib/args/README.md)); `parseArgs` calls `args.parse(argv)`; set
   `writes` for anything that changes or executes remote state. A write that changes a method
   goes through the draft guard and [`../lib/save/`](../lib/save/README.md).
2. `help.txt` and `desc.txt` as above.
3. An entry in `registry.ts`, kept sorted.
4. A test in [`../tests/unit`](../tests/unit/README.md).

Up: [`../README.md`](../README.md)
