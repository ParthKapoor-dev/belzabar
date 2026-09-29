# ad run

Live-executes a **published** method.

```bash
belz ad run <publishedId> [PAYLOAD_JSON_OR_FILE] --env <env> [--raw] [--stream]
```

- Sends `POST /rest/api/automation/chain/execute/<id>?encrypted=true` with the raw
  token (no `Bearer` prefix).
- If you pass a DRAFT uuid, the platform runs the PUBLISHED body linked to it. belz
  warns about this and reports `inputState` / `executesPublishedUuid`. To execute a
  draft, use `belz ad test`.
- `--stream` sends `Accept: application/stream+json`. The progressive chunks and the
  final JSON envelope are parsed separately (`lib/stream-parser.ts`). No timeout is
  applied.
- The command has real side effects, so it declares `writes` and needs an explicit
  `--env`.
