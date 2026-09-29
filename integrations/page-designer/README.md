# Page Designer CLI (`belz pd`)

Inspect, validate, snapshot, edit and publish Page Designer pages and components.
Maintainer notes live in `AGENTS.md`; the exact flags of every command are in
`belz pd <cmd> --help` and `belz --help-full`.

`<input>` accepts an app page URL, a PD designer URL, a bare hex id, or an exact page/component name.

## Read

```bash
belz pd show <input>                      # overview: name, ids, variable/HTTP/component counts
belz pd show <input> --vars               # variables (user-defined + derived)
belz pd show <input> --http               # HTTP service calls with AD ids and triggers
belz pd show <input> --tree               # layout tree with node-kind badges and pitfalls
belz pd show <input> --find "Save"        # locate nodes: id + key path (for overlay edits)
belz pd show <input> --var-detail <name>  # one variable's full config
belz pd show <input> --http-detail 1      # the Nth HTTP call in full
belz pd find "notice"                     # fuzzy search pages/components (7-day cached index)
belz pd find-ad-methods <input> -r        # AD method ids used, following components
belz pd page-deps <input>                 # page-dependencies summary
belz pd diff <input> --from nsm-dev --to nsm-qa
belz pd history list <pageId>             # server version history
```

Reads are cached per env (5 min soft / 1 h hard); `--force` fetches fresh.

## Validate and snapshot

```bash
belz pd validate <input>                  # exit 1 on any validator error
belz pd validate <input> --recursive      # also every symbol the page uses
belz pd snapshot <input> --out snapshots/page.json        # normalized baseline for git
belz pd snapshot <input> --compare snapshots/page.json    # exit 1 when the live page differs
```

## Edit and publish

Writes need an explicit `--env`, and `--yes` in `--llm` or non-interactive mode.

```bash
belz pd preflight <pageId> --overlay edit.json           # dry run: plan + validate, no write
belz pd save <pageId> --overlay edit.json --env nsm-dev  # validated, locked save of the draft
belz pd publish <pageId> --env nsm-dev
```

An overlay edits the draft's raw config, e.g. `{"nodes":{"update":[{"id":"<nodeId>","props":{…}}]}}`;
see `AGENTS.md` for every section. Add `--llm` to any command for a JSON envelope.
