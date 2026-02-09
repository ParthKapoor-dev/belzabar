# Automation Designer Agent Contract

This document defines the operational contract for AI agents interacting with the Automation Designer (AD) via `belzabar-cli`.

## 1. System Overview

**Automation Designer (AD)** is a low-code platform for building automation chains.
A **Method** is a linear sequence of **Services** (steps).

*   **Draft**: Editable version. Used for testing/debugging.
*   **Published**: Read-only, live version.
*   **Service**: A step in the chain (e.g., SQL Query, Custom Code, API Call).
*   **Trace**: The execution log of a method run, containing inputs, outputs, and status for each service.

## 2. CLI Capabilities

The CLI provides read and test access only.

*   `show-method <UUID>`: Inspects method definition (inputs, services, outputs).
*   `test-method <UUID>`: Runs the **Draft** version of a method with provided inputs.
*   `fetch-method <UUID>`: Fetches raw definition (mostly internal use, prefer `show-method`).

**Note:** There is **NO** ability to edit code, modify SQL, or change configuration via this CLI.

## 3. Agent Mandates

1.  **Inspect First**: Always run `show-method` before `test-method` to understand required inputs and service logic.
2.  **Test for Diagnosis**: Run `test-method` to reproduce errors or verify behavior.
3.  **No Hallucinations**:
    *   Do not invent inputs that don't exist in the definition.
    *   Do not assume a database schema exists unless you see a SQL service querying it.
    *   Do not try to "fix" code. You can only **report** the fix suggestion based on the trace.

## 4. Usage Patterns

### Diagnosis Workflow
1.  **Understand**: `show-method <UUID> --llm` -> Analyze inputs and logic.
2.  **Reproduce**: `test-method <UUID> --inputs <file> --llm` -> Check for failure.
3.  **Analyze**: Look at `failedStep` in the output. Match it to the service definition from step 1.

### Signals
*   **Success**: `status: "SUCCESS"` (or `executionStatus.failed: false`).
*   **Failure**: `status: "FAILED"`. Look for `failedStep` object.
*   **Skipped**: Steps after a failure are skipped.

## 5. Hallucination Boundaries

*   **Database**: You cannot see tables. You can only see the SQL in `show-method`.
*   **Code**: You cannot see external libraries. You can only see the JavaScript in `show-method`.
*   **Fixing**: You cannot apply fixes. You must explain *what* is wrong (e.g., "Input 'id' is null but required by Service 2").

## 6. Output Schemas (LLM Mode)

All commands with `--llm` return strictly structured JSON.

**Common Envelope:**
```json
{
  "schema": "ad.<type>",
  "version": "1.0",
  ...data
}
```

Do not parse standard output (logs, ASCII tables) when `--llm` is active.
