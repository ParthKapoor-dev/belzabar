# Show Command

Displays detailed metadata, inputs, and service steps for an Automation Method,
or for a local method JSON file (nothing fetched).

## Usage

```bash
belz ad show <UUID|URL|FILE> [flags]
```

## Views

- default: summary table + step list. The `--llm` payload is lean (Stage 7.1):
  no request echo, empty/null fields pruned (`lib/compact.ts:pruneEmpty`),
  SQL/code bodies only with `--sql` / `--code` / `--full` / `--service-detail`,
  the wire body only with `--raw` (once, as `data.raw`).
- `--compact`: `lib/method-view.ts:compactMethod` — `{view:"compact", name,
  category, state, version, uuid, in, out, vars, steps: string[], blocks?}`;
  one line per step. `--sql` / `--code` / `--full` add full bodies as `blocks`.
- `--story`: `lib/method-view.ts:storyMarkdown` — the plain-English pre-save
  approval template, `{view:"story", name, uuid, markdown}`.

## Flags

- `--inputs`, `--outputs`, `--variables`, `--services`: sections.
- `--service-detail <n>` / `--step <n>`: one step (1-based orderIndex).
- `--code`, `--sql`: include decoded bodies.
- `--full`: everything.
- `--raw`: the wire body once.
- `--force`: bypass the cache (5-min stale-while-revalidate otherwise).
- `--open`, `-o`: open the editable draft in the browser.
- `--v2`: fetch through the V2 API.
