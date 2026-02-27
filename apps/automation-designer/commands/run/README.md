# Run Method Command

Executes an Automation Method using its Published ID.

## Usage

```bash
bun run bin/cli.ts run-method <PUBLISHED_ID> [PAYLOAD_JSON_OR_FILE] [--raw]
```

## Logic

- Authenticates using Raw token (No "Bearer" prefix).
- Sends a POST request to `/rest/api/automation/chain/execute/...`
- Requires `encrypted=true` query param (handled automatically).
- Displays response JSON or text.
- `--raw` includes request payload in output data.
