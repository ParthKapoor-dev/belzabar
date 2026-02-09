# Run Suites Command

Executes all regression tests defined in the `suites/` directory against the live API.

## Usage

```bash
bun run bin/cli.ts run-suites
```

## Logic

1. Scans `suites/*.spec.json`.
2. For each suite:
    - Fetches the *latest* definition for the UUID (Draft or Published).
    - Injects the saved input values into the definition.
    - Sends the payload to the Test API (`/rest/api/automation/chain/test`).
    - Verifies that `executionStatus.failed` is `false`.
3. Reports a summary of Passed vs Failed suites.

**Note:** This command asserts *Execution Success* only. It does not assert specific output values (like Database IDs) to avoid brittleness in dynamic environments.
