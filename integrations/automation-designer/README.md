# @belzabar/ad — Automation Designer

The `wi-impl ad` commands and the library behind them: read, search, edit, validate, save,
publish, test and trace Automation Designer methods, and run SQL through the platform.

Automation Designer keeps backend logic as versioned **methods** ("chains") of steps. A method
has a DRAFT chain and, once published, a PUBLISHED chain; the two have separate uuids and
independent version counters. wi-impl edits only drafts.

## Role in the monorepo

The package has no entry point of its own. `apps/cli` compiles it into `wi-impl` through
[`registry.ts`](registry.ts); other workspaces import the library:

| Export | Used by |
|---|---|
| `@belzabar/ad/registry` | `apps/cli` (routing and `wi-impl --help-full`) |
| `@belzabar/ad/lib/*` | `release` (`lib/trace`), the CLI live tests (`lib/api/v2`, `lib/save/api`) |

It depends on `@belzabar/core` and on `@belzabar/pd` (`ad callers --pd` scans PD pages).

## Layout

| Path | Contents |
|---|---|
| [`commands/`](commands/README.md) | One folder per command (`index.ts`, `help.txt`, `desc.txt`) and the command map. |
| [`lib/`](lib/README.md) | The library: API clients, parser, save pipeline, validator, test cases, SQL, caches. |
| [`tests/`](tests/README.md) | Unit and command tests, sanitized real fixtures. |
| `registry.ts` | The static, sorted command registry. |

## Typical loop

```bash
wi-impl ad find "order list"                        # locate a method (cached index)
wi-impl ad show <uuid> --compact                    # read it, one line per step
wi-impl ad lint <uuid>                              # review it
wi-impl ad save edit.json --uuid <uuid> --dry-run --env <env>  # plan + validate; writes nothing
wi-impl ad save edit.json --uuid <uuid> --env <env>
wi-impl ad test <uuid> --env <env> --inputs in.json --expect out=42
wi-impl ad publish <uuid> --note "why" --env <env>
```

Every command's reference is its `help.txt`: `wi-impl ad <cmd> --help`, or `wi-impl --help-full` for
all of them.

## Behaviour common to every command

- `--llm` returns the core JSON envelope; machine output never goes through `console.log`.
- Writes (anything that changes or executes remote state) need an explicit `--env` and a
  confirmation; in `--llm` mode `--yes` replaces the prompt (`AD_CONFIRMATION_REQUIRED`
  without it).
- Every write to a method goes to its DRAFT: a PUBLISHED uuid is switched to its linked draft
  (see the draft guard in [`lib/README.md`](lib/README.md)).
- Method uuids may be given in any spelling or as an AD URL.
- Error codes are stable and listed in each help.txt. Main families: `INVALID_UUID`,
  `METHOD_NOT_FOUND` (also for a soft-deleted method, `details.deleted: true`),
  `AD_DRAFT_GUARD_*`, `AD_OVERLAY_*`, `AD_SERIALIZER_DRIFT`, `AD_SPEC_*`,
  `AD_VALIDATION_FAILED`, `AD_VERSION_CONFLICT`, `AD_SAVE_*`, `AD_METHOD_EXISTS`,
  `AD_CATEGORY_PROTECTED`, `AD_IMPORT_*`, `AD_DELETE_*`, `AD_TEST_*`, `AD_TESTCASE_*`,
  `AD_LINT_FAILED`, `HISTORY_*`, `RESTORE_UNCONFIRMED`, `SQL_*`.

## Configuration

| Setting | Effect |
|---|---|
| `environments.<env>.sqlDefaultDb` in `~/.wi-impl/config.json` | Default database for `ad sql` on that env. |
| `WI_IMPL_SQL_DEFAULT_DB` | Default database for `ad sql` on every env (after the config key). |
| `"lint": {"resolverTables": {"<table>": "<fn>"}}` in `~/.wi-impl/config.json` | Enables lint rule Q3 (tables that must be read through a resolver function). |

Caches live under `~/.wi-impl/cache/` (see [`lib/README.md`](lib/README.md#caching)).

## Testing

`bun test integrations/automation-designer` (no network), or `bun run check` from the repo root.
See [`tests/README.md`](tests/README.md). Live suites are opt-in and live in
[`apps/cli/tests/live`](../../apps/cli/tests/live/README.md).

Maintainer rules: [`AGENTS.md`](AGENTS.md).
