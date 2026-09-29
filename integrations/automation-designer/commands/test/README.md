# Test Command

Executes an Automation Designer method (usually the draft) with given input values.

## Usage

```bash
belz ad test <UUID> --env <env> [flags]
```

## Logic

1. Fetches the method definition (V1).
2. Collects inputs (interactively, `--inputs` JSON file, or `--case` test-case file).
3. Injects `testValue` for each input and posts the definition to `/rest/api/automation/chain/test`
   (`lib/test-run.ts:runInlineTest`).
4. Reports every method output (`outputs {code: value}`), the step trace, and — with
   `--expect` / `--case` — a pass/fail row per expectation (exit 1 on any failure).
5. `--compare-published` runs the same inputs against the published copy and diffs
   the outputs (`compare`).

## Flags

- `--inputs <file>`: Pre-fill inputs from a JSON file.
- `--case <file>`: Inputs + assertions from a test-case file (`ad test-case export` format).
- `--expect <out=value>`: Repeatable output check (`lib/test-cases/expect.ts`).
- `--compare-published`: Draft vs published output diff.
- `--verbose`: Show deep inspection of step outputs.
- `--raw`: Include the raw execution response.
