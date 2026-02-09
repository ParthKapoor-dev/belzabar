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

## Flags

- `--inputs`: Show input arguments table.
- `--services`: Show service chain table.
- `--service-detail <n>`: Inspect a specific step (0-indexed).
- `--full`: Dump raw JSON.
- `--force`: Bypass cache.
