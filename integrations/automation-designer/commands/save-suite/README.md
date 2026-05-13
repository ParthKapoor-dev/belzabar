# Save Suite Command

Creates a persistent regression test case ("Suite") for an Automation Method.

## Usage

```bash
bun run bin/cli.ts save-suite <UUID> --name <suite-name> [flags]
```

## Logic

- Fetches the method definition to validate the UUID.
- Collects input values (interactively or via `--inputs`).
- Creates a JSON specification file in the `suites/` directory.
- This suite can later be executed by `run-suites`.

## Output

Creates a file at `suites/<suite-name>.spec.json`.
