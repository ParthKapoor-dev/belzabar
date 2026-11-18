# lib/args — shared AD flag fragments and the write gate

Spec pieces that AD commands spread into their core `defineArgs` specs, plus the
confirmation gate every AD write uses. `--env` and `--llm` belong to the runner, not here.

| File | Contents |
|---|---|
| `common.ts` | `AD_V2_FLAG` (`--v2`, only on commands that read a method) with `apiVersionOf`; `AD_YES_FLAG` (`--yes`, `-y`); `AD_NOTE_FLAG` (`--note`). |
| `subcommand-help.ts` | `subcommandHelp`: a command's help.txt narrowed to one subcommand (`CommandModule.helpFor`), for `wi-impl ad sql update --help`. It keeps the asked `Subcommands:` entry, sections whose header ends in `(<sub>, …):` only for a listed subcommand, and the matching `Examples:` lines. |
| `confirm.ts` | `requireConfirmation`: fails `AD_CONFIRMATION_REQUIRED` in `--llm` mode without `--yes`, otherwise prompts. `logIntent`: the `[wi-impl ad write]` stderr line naming the target env. |

The validator flags shared by `save`, `publish` and `create` (`--no-validate`, `--strict`,
`--dry-run-compile`) live in [`../save/flags.ts`](../save/flags.ts).

A flag added here changes every command that spreads it: update each of those commands'
`help.txt` and `desc.txt` (the args-docs test enforces it).

Up: [`../README.md`](../README.md)
