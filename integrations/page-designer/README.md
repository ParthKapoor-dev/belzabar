# Page Designer (`@belzabar/pd`, `belz pd`)

Inspect, lint, snapshot, edit and publish Page Designer (PD) pages and components
(symbols). A workspace package with no binary of its own: `apps/cli` wires its registry into
`belz pd <cmd>`.

## In this directory

| Path | What it is |
|---|---|
| [`registry.ts`](./registry.ts) | Sorted, hand-maintained map of every `belz pd` command |
| [`commands/`](./commands/README.md) | One folder per command (`index.ts`, `help.txt`, `desc.txt`) |
| [`lib/`](./lib/README.md) | Everything the commands share: API client, parser, serializer, validator, write pipeline |
| [`tests/`](./tests/README.md) | Unit and command-level tests, real and wire fixtures |
| `package.json`, `tsconfig.json`, `bunfig.toml` | Workspace manifest; the test preload points `WI_IMPL_HOME` at a temp dir |

## Public exports

- `@belzabar/pd/registry`: the command registry, imported by `apps/cli`.
- `@belzabar/pd/lib/*`: any lib module. `belz ad callers --pd` uses `lib/ad-refs.ts`.

## Commands

`belz --help-full` lists every invocation; each command's `help.txt` is its full reference.

| Group | Commands |
|---|---|
| Read | `show`, `find`, `find-ad-methods`, `analyze`, `page-deps`, `translations`, `diff`, `history list/show/diff` |
| Check | `lint`, `snapshot`, `preflight` |
| Write | `save`, `publish`, `history restore`, `lock acquire/release` |

`<input>` is an app page URL, a PD designer URL (`/ui-designer/page/<id>` or
`/ui-designer/symbol/<name>`), a bare hex id, or an exact page/component name (component first,
then page; several matches → `PD_NAME_AMBIGUOUS`).

```bash
belz pd show <input> --find "Save"                      # node ids + key paths, for overlays
belz pd lint <input> --recursive                    # page + every symbol it uses
belz pd snapshot <input> --compare snapshots/page.json  # exit 1 when the live page differs
belz pd preflight <pageId> --overlay edit.json          # plan + validate, never writes
belz pd save <pageId> --overlay edit.json --env dev --yes
belz pd publish <pageId> --env dev --yes
```

## Contracts

- **Envelope.** `--llm` returns the core envelope; the runner names the schema `pd.<cmd>`.
  Report-style failures keep the report in `data` (`failWithData`, exit 1):
  `PD_VALIDATION_FAILED`, `PD_PREFLIGHT_FAILED`, `PD_SNAPSHOT_DIFFERS`, `PD_LOCK_RELEASE_FAILED`,
  `PD_SAVE_VERIFY_FAILED`, `PD_TRANSLATIONS_FAILED`, `PD_COMPLIANCE_FAILED` /
  `PD_COMPLIANCE_INCOMPLETE`. A write refused by the validator gate is a `CliError`
  `PD_VALIDATION_FAILED` with the errors in `details.issues`.
- **Error codes** all start with `PD_` (grep `"PD_` in `lib/` and `commands/`). HTTP failures
  are `PD_API_ERROR`, or `PD_LOCKED` on 409 (`lib/api/client.ts`). Argument errors come from core
  `defineArgs` (`MISSING_INPUT`, `UNKNOWN_FLAG`, …).
- **Writes** (`save`, `publish`, `history restore`, `lock acquire/release`) need an explicit
  `--env`. `save`, `publish` and `history restore` also need confirmation (`--yes`/`-y` in
  `--llm` or without a terminal), log one JSON intent line to stderr, run inside the page lock
  and only ever write a DRAFT (see [`lib/`](./lib/README.md#write-pipeline)). Their overrides:
  `--force-validation` (write despite validator errors; listed in `bypassedErrors`) and
  `--allow-published` (`save`/`publish` only: a PUBLISHED page with no linked draft). On read
  commands `--force` means "bypass the cache".
- **Cache.** Page configs are cached per env under `~/.wi-impl/cache/pages/<env>/` (5 min soft,
  1 h hard TTL); `find` keeps a 7-day index. `lint`, `snapshot` and every write read fresh.

## Configuration

Uses the active `belz` environment and its saved session (`@belzabar/core` config); nothing
PD-specific. Runtime files: the page cache above, `~/.wi-impl/pd-locks/<env>.json` (locks taken with
`belz pd lock acquire`) and `~/.wi-impl/cache/pd-ad-refs/` (the index `ad callers --pd` reads).

## Testing

```bash
bun test integrations/page-designer        # unit + command-level, no network
```

Details, fixtures and the opt-in live write suite: [`tests/`](./tests/README.md).

## Known gaps

1. `pd diff` across envs reports HTTP calls as changed when their env-local AD ids differ.
2. App-URL resolution needs a registered deployment domain; the validator is static only.
3. The 409 body for a lock held by another user has never been captured; belz names the holder
   from the page's `pageLockDetails` instead.
4. No API is known that sets a row back to PUBLISHED; reverting a PUBLISHED id would flip it to
   DRAFT, so belz never does it, and a sibling left `DELETED` counts as absent.
