# Test Command

Executes a Draft Automation Method by injecting specific input values.

## Usage

```bash
belz ad test <UUID> [flags]
```

## Logic

1. Fetches the method definition.
2. Collects inputs (interactively or via `--inputs` JSON file).
3. Modifies the definition's JSON to inject `testValue` for each input.
4. Sends the modified definition to the `/rest/api/automation/chain/test` endpoint.
5. Prints the Execution Trace (Steps, Status, Time) and final Output.

## Flags

- `--inputs <file>`: Pre-fill inputs from a JSON file.
- `--verbose`: Show deep inspection of step inputs/outputs.
- `--force`: Fetch fresh definition (ignore cache).
