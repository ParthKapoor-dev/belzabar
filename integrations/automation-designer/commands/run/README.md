# ad run

Live-executes a method's saved body (normally the published copy).

```bash
belz ad run <publishedId> [PAYLOAD_JSON_OR_FILE] --env <env> [--raw] [--stream]
```

- Sends `POST /rest/api/automation/chain/execute/<id>?encrypted=true` with the raw
  token (no `Bearer` prefix).
- The execute endpoint runs the uuid's OWN saved body: a DRAFT uuid runs the draft
  (unpublished changes included; never-published drafts run too). belz warns and
  reports `inputState` / `publishedUuid` (the published copy, null if never
  published) — pass that uuid to run what is published.
- `EXECUTION_FAILED` details are an object `{path, status, body}` (redacted).
- `--stream` sends `Accept: application/stream+json`. The progressive chunks and the
  final JSON envelope are parsed separately (`lib/stream-parser.ts`). No timeout is
  applied.
- The command has real side effects, so it declares `writes` and needs an explicit
  `--env`.
