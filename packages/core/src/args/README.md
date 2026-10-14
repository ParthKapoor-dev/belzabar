# core/src/args

Declarative argument parsing for every wi-impl command. A command describes its positionals and
flags once; `parse(argv)` returns typed values or throws a `CliError` with a stable code, and
the spec stays inspectable so tests can check `help.txt` / `desc.txt` against it.

## What's here

| File | Contents |
|------|----------|
| `spec.ts` | Spec types (`ArgsSpec`, `FlagSpec`, `SubcommandsSpec`, …), `GLOBAL_FLAGS`, `ARG_ERROR_CODES`, the spec → parsed-type mapping |
| `parse.ts` | `defineArgs`, `defineSubcommands`, `specsOf`, `acceptedFlags`, `declaresFlag`, `suggest` |
| `index.ts` | Re-exports both, with a usage example |

## Usage

```ts
export const args = defineArgs({
  command: "wi-impl ad show",
  positionals: [{ name: "uuid", required: true }],
  flags: {
    step: { type: "number", integer: true, min: 1 },
    full: { type: "boolean" },
  },
});
const { flags, positionals } = args.parse(argv); // flags.step: number | undefined
```

- Flag types: `boolean`, `string` (`allowDashValue`, `allowEmpty`), `number` (`integer`, `min`,
  `max`), `enum` (`values`, case-insensitive by default). Any flag: `alias`, `required`,
  `repeatable`, `default`, `description`. Kebab-case keys become camelCase properties.
- Positionals: `required`, `variadic` (last only). `allowExtraPositionals` collects the rest
  into `extra`.
- Groups: `exclusive` (at most one) and `requireOneOf` (at least one).
- `parsed.provided` holds the flag keys given explicitly; `afterDoubleDash` the tokens after `--`.
- `defineSubcommands(map, {default?, aliases?})` selects a spec by `argv[0]`.
- `codes` remaps error codes for commands whose codes predate this module; new specs leave it unset.

## Contracts

- Every command module exports its definition as `args`; the runner (`declaresFlag`) and the
  help/desc drift check (`checkCommandDocs` in `@belzabar/core/testing`) read it.
- The runner owns `GLOBAL_FLAGS` (`--llm`, `--env`/`-e`, `-v`/`--verbose`, `--help`/`-h`,
  `--help-full`); commands never declare them, except a command may declare `--verbose`.
- Error codes: `UNKNOWN_FLAG` (with a did-you-mean from `search.levenshtein`), `MISSING_VALUE`,
  `INVALID_VALUE`, `MISSING_FLAG`, `MISSING_ARGUMENT`, `UNEXPECTED_ARGUMENT`,
  `CONFLICTING_FLAGS`, `DUPLICATE_FLAG` (`details.values` names both), `UNKNOWN_SUBCOMMAND`,
  `MISSING_SUBCOMMAND`. A string value starting with `-` is `MISSING_VALUE` with a
  `--flag=<value>` hint in `details.hint`; long tokens are truncated in messages.

Tests: `packages/core/tests/args.test.ts`. Up: [src](../README.md).
