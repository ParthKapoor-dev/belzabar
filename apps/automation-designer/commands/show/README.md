# Show Method Command

Displays detailed metadata, inputs, and service steps for an Automation Method.

## Usage

```bash
bun run bin/cli.ts show-method <UUID> [flags]
```

## Logic

- Fetches the method definition (uses cache by default).
- Displays a summary table (Name, State, Version, etc.).
- Can list defined Inputs (`--inputs`).
- Can list the Service Chain (`--services`).
- Can drill down into specific service details (`--service-detail <index>`).
- Can include expanded service logic details (`--full`).
- Can include raw payloads (`--raw`).

## Flags

- `--inputs`: Show input arguments table.
- `--services`: Show service chain table.
- `--service-detail <n>`: Inspect a specific step (0-indexed).
- `--full`: Include expanded service logic details.
- `--raw`: Include raw payloads in output data.
- `--force`: Bypass cache.
