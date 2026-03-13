// Worker delegation contracts — schema-versioned input/output envelopes.
// Workers are headless ACP agent sessions with bounded task scope.

export type WorkerTask<T = unknown> = {
  /** Schema identifier, e.g. "method-summarize:v1" */
  schema: string
  /** Task-specific input, typed per schema */
  input: T
}

export type WorkerResult<T = unknown> = {
  /** Echoed schema identifier from the task */
  schema: string
  status: "success" | "failure" | "timeout"
  /** Structured output (present on success) */
  output?: T
  /** Full raw agent response text — for debugging */
  rawOutput?: string
  durationMs: number
  error?: string
}
