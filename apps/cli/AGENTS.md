# AGENTS.md — CLI (`apps/cli`)

Docs: [`README.md`](./README.md) (routing, build, install) and the READMEs in `bin/`,
`commands/`, `scripts/`, `tests/`. The command reference is `wi-impl --help-full`.

## Rules

- Never run `bun run wi-impl:install`, `wi-impl:reinstall`, `wi-impl update`, `wi-impl setup` or
  `wi-impl onboard` as part of a change; they touch the real `~/.wi-impl` and binary. Tests use
  scratch homes.
- `wi-impl --help-full` must stay deterministic: no env-, clock-, locale- or build-dependent text.
- Scripts that write `~/.wi-impl/config.json` write atomically with mode 0600 and never overwrite
  a config they cannot parse.

## Adding a command

- **Top-level:** create `commands/<name>/{index.ts,help.txt,desc.txt}` (declare `args` with
  `defineArgs` / `defineSubcommands`; set `writes` / `writesLocal` / `envAware` as needed) and
  add it to `commands/registry.ts` in sorted order. If it self-routes a namespace like `config`,
  add it to `PASSTHROUGH` in `bin/options.ts`; if it never talks to an env, add it to
  `NOT_ENV_AWARE_TOP_LEVEL`.
- **Integration command:** folder under `integrations/<x>/commands/` plus an entry in that
  package's `registry.ts`; see that package's `AGENTS.md`.
- **New namespace:** new integration package (package.json, tsconfig, `registry.ts`); add it to
  this package's dependencies and to `NAMESPACES` + `REGISTRIES` in `bin/options.ts`.

desc.txt is one line per invocation, `wi-impl <…>  :->  <what it does>`. `tests/args-docs.test.ts`
fails when help.txt or desc.txt drift from the args spec; `tests/registry.test.ts` fails when
folders and registries disagree. No README.md inside a command folder: `help.txt` is its doc.

## When you change something

Update the README of the directory you changed, the registry, and the command's `help.txt` /
`desc.txt` in the same commit; this file only when an agent rule changes.
