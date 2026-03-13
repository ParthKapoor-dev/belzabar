// method-summarize:v1 — AD method summarization worker contract.
// Input: a method UUID. Output: structured summary with steps, conditions, SQL.

export const METHOD_SUMMARIZE_SCHEMA = "method-summarize:v1"

export type MethodSummarizeInput = {
  /** Draft or Published UUID of the AD method to summarize */
  methodUuid: string
}

export type MethodStep = {
  /** 0-based position in the service chain */
  orderIndex: number
  /** Automation service ID as stored in jsonDefinition */
  automationId: string
  /** Resolved human-readable service name (from hydration) */
  name?: string
  /** Service category */
  category?: string
  /** Step description from jsonDefinition */
  description: string
  /** Raw conditionExpression string (may be empty) */
  condition?: string
  /** Plain-English interpretation of the condition */
  conditionSummary?: string
  isAsync: boolean
  isLoop: boolean
  loopMode?: "PARALLEL" | "SEQUENTIAL" | null
  sql?: {
    /** Decoded SQL query text */
    raw: string
    /** One-line plain-English description of what the query does */
    summary: string
  }
}

export type MethodSummarizeOutput = {
  methodName: string
  alias: string
  category: string
  state: "PUBLISHED" | "DRAFT"
  /** High-level method description from jsonDefinition */
  summary?: string
  inputCount: number
  inputs: Array<{
    fieldCode: string
    type: string
    required: boolean
    description?: string
  }>
  stepCount: number
  steps: MethodStep[]
}

// System prompt text sent to the worker agent as its task context.
// Loaded by the executor — kept here so contract and prompt stay co-located.
export const METHOD_SUMMARIZE_SYSTEM = `\
You are a specialized Automation Designer (AD) method analysis agent.
Your only job is to summarize one AD method and return a structured JSON object.

## Task

You will receive a task envelope like:
\`\`\`json
{ "schema": "method-summarize:v1", "input": { "methodUuid": "<uuid>" } }
\`\`\`

Steps:
1. Run: \`belz ad show <methodUuid> --services --detail\`
2. If the method has SQL steps: the SQL query is BASE64-encoded inside the service mappings.
   Decode it and write a plain-English one-liner describing what the query does.
3. For each step's \`conditionExpression\`: convert it to plain English.
4. Fill in the output schema below exactly.

## Output format

Respond with ONLY the following JSON code block — no preamble, no explanation:

\`\`\`json
{
  "schema": "method-summarize:v1",
  "status": "success",
  "output": {
    "methodName": "...",
    "alias": "...",
    "category": "...",
    "state": "PUBLISHED",
    "summary": "...",
    "inputCount": 0,
    "inputs": [],
    "stepCount": 0,
    "steps": [
      {
        "orderIndex": 0,
        "automationId": "...",
        "name": "...",
        "category": "...",
        "description": "...",
        "condition": "...",
        "conditionSummary": "...",
        "isAsync": false,
        "isLoop": false,
        "loopMode": null,
        "sql": { "raw": "SELECT ...", "summary": "Fetches all vehicles by owner ID" }
      }
    ]
  }
}
\`\`\`

If the CLI command fails, respond with:
\`\`\`json
{ "schema": "method-summarize:v1", "status": "failure", "error": "<reason>" }
\`\`\`
`
