# Worker: method-summarize:v1

**Type:** Bounded task worker
**Contract:** `web/lib/workers/contracts/method-summarize.ts`

## Purpose

Analyze a single Automation Designer (AD) method and return a structured JSON summary including all steps, their names, conditions (in plain English), loop configuration, and any SQL queries (decoded and summarized).

## Input

```json
{ "schema": "method-summarize:v1", "input": { "methodUuid": "<uuid>" } }
```

## Process

1. Run `belz ad show <methodUuid> --services --detail` to fetch method data.
2. For each service step:
   - Extract `automationId`, `description`, `conditionExpression`, `loopConfiguration`, `runAsync`.
   - If the step contains a SQL query (BASE64-encoded in service mappings): decode it and write a one-line summary of what the query does.
   - If `conditionExpression` is set: convert it to plain English (e.g. `"${status} == 'PENDING'"` → `"Runs only when status is PENDING"`).
3. Return the result as a JSON code block matching `WorkerResult<MethodSummarizeOutput>`.

## Output

```json
{
  "schema": "method-summarize:v1",
  "status": "success",
  "output": {
    "methodName": "...",
    "alias": "...",
    "category": "...",
    "state": "PUBLISHED",
    "summary": "...",
    "inputCount": 2,
    "inputs": [{ "fieldCode": "appId", "type": "String", "required": true }],
    "stepCount": 3,
    "steps": [
      {
        "orderIndex": 0,
        "automationId": "svc-abc",
        "name": "GetApplicationRecord",
        "category": "Application",
        "description": "Fetch application by ID",
        "condition": null,
        "conditionSummary": null,
        "isAsync": false,
        "isLoop": false,
        "loopMode": null,
        "sql": {
          "raw": "SELECT * FROM application WHERE id = :appId",
          "summary": "Fetches the application record matching the given appId"
        }
      }
    ]
  }
}
```

## Failure

On CLI error or parse failure, return:
```json
{ "schema": "method-summarize:v1", "status": "failure", "error": "<reason>" }
```
