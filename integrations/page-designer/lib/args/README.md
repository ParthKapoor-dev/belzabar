# `lib/args/`: shared flag fragments

[`common.ts`](./common.ts) holds the core `defineArgs` spec fragments PD commands spread into
their own `args`. Spread a fragment only where the flag means something (read commands do not
take `--yes`); `--env` and `--llm` belong to the runner.

| Fragment | Flags | Used by |
|---|---|---|
| `PD_FORCE_FLAG` | `--force`: bypass the page cache | read commands |
| `PD_WRITE_OVERRIDE_FLAGS` | `--force-validation`, `--allow-published` | `save`, `publish` (restore takes `--force-validation` only) |
| `PD_YES_FLAG` | `--yes` / `-y`: skip the confirmation prompt | write commands |
| `PD_DRY_RUN_FLAG` | `--dry-run`: run everything but the write | `save` |
| `PD_DEP_STATUS_FLAG` | `--status PUBLISHED\|DRAFT` (default PUBLISHED) | `page-deps`, `translations` |
| `PD_INPUT_POSITIONAL` | `<input>`, `MISSING_INPUT` when absent | commands taking a page/component |

`WriteOverrides` is the parsed shape of the override flags. Changing a fragment changes every
command that spreads it: update those commands' `help.txt`/`desc.txt` in the same change
(`apps/cli/tests/args-docs.test.ts` checks them).

Up: [`../README.md`](../README.md).
