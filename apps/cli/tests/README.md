# apps/cli/tests

Tests that span every package: they load all registries through `bin/options.ts` and check the
whole command set. Run with `bun test apps/cli` or `bun run check`.

| File | Guards |
|------|--------|
| `registry.test.ts` | Every `commands/*/` folder of every package is registered, sorted, with non-empty help.txt / desc.txt; every registered command routes |
| `args-docs.test.ts` | help.txt / desc.txt agree with each command's `args` spec (`checkCommandDocs`) |
| `args-parse.test.ts`, `args-parse-setup.test.ts` | Top-level commands reject bad argv (parse only) |
| `write-commands.test.ts` | Every remote-write command or sub-action declares `writes`; local writers declare `writesLocal` |
| `envelope-contract.test.ts` | Every command's help and error `--llm` output validates against `EnvelopeSchema`, `ok:false` ⇔ nonzero exit, stdout is only the envelope (`KNOWN_VIOLATIONS` entries must stay justified) |
| `envelope-success.test.ts` | Read commands over the sanitized fixtures in `integrations/*/tests/fixtures/` (via fakeFetch) return valid `ok:true` envelopes |
| `help-full.test.ts` | `--help-full` is byte-for-byte deterministic across env, TZ and locale |
| `help-flags.test.ts` | `--help` anywhere shows help instead of running the command |
| `entry.test.ts` | `bin/cli.ts` spawned: `--version`, registry load-failure report |
| `compiled-pipe.test.ts` | Compiles to a tmp dir; a >64 KiB `--llm` envelope survives a slow pipe |
| `install-scripts.test.ts` | `record-install.mjs` in a scratch HOME (0600/0700, keeps sections, refuses malformed config); installers decide first run before recording |
| `onboard.test.ts` | A failed step → `ONBOARD_INCOMPLETE` (exit 1); Ctrl-C (`USER_ABORT`) ends the flow |
| `cache-command.test.ts`, `cache-prune-local.test.ts` | `wi-impl cache` invalidate body and guards; `prune-local` |
| `setup-config-exec.test.ts` | `setup` merges and stores explicit password encodings; `config token` re-logs in on expiry or `--refresh` |
| `update-paths.test.ts` | `wi-impl update` never discards local work and installs to the recorded dir |
| `self-update.test.ts` | Release versions and targets, manifest + verified download against a local fake release server (checksum mismatch refused), the auto-update gate, swap and rollback |
| [`live/`](./live/README.md) | Opt-in suites against a real environment |

Up: [apps/cli](../README.md).
