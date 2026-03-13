import { bridge } from "@/lib/acp-bridge"
import type { WorkerTask, WorkerResult } from "./types"

type RunParams = {
  task: WorkerTask<unknown>
  /** System prompt / instructions to prepend to the task JSON */
  systemPrompt: string
  agentName?: string
  cwd: string
  timeoutMs?: number
}

/**
 * WorkerExecutor — runs a single-prompt headless ACP agent session.
 *
 * The agent receives:
 *   <systemPrompt>
 *   <task-json>
 *
 * and is expected to respond with a JSON code block that matches WorkerResult.
 * The executor extracts and parses that block, then closes the session.
 */
export class WorkerExecutor {
  async run<T>(params: RunParams): Promise<WorkerResult<T>> {
    const { task, systemPrompt, agentName = "opencode", cwd, timeoutMs = 120_000 } = params
    const taskJson = JSON.stringify(task, null, 2)
    const prompt = `${systemPrompt}\n\nTask:\n\`\`\`json\n${taskJson}\n\`\`\``

    let rawOutput = ""
    let status: WorkerResult<T>["status"] = "failure"
    let output: T | undefined
    let error: string | undefined
    const startedAt = Date.now()

    try {
      const result = await bridge.runWorker(agentName, cwd, prompt, timeoutMs)
      rawOutput = result.text
      const parsed = extractJson<WorkerResult<T>>(rawOutput)

      if (parsed && parsed.schema === task.schema) {
        status = parsed.status
        output = parsed.output
        error = parsed.error
      } else {
        status = "failure"
        error = "Agent did not return a valid WorkerResult JSON block"
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      status = msg.toLowerCase().includes("timed out") ? "timeout" : "failure"
      error = msg
    }

    return {
      schema: task.schema,
      status,
      output,
      rawOutput,
      durationMs: Date.now() - startedAt,
      error,
    }
  }
}

// Extract the first JSON code block from agent output
function extractJson<T>(text: string): T | null {
  // Match ```json ... ``` or ``` ... ```
  const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (match) {
    try {
      return JSON.parse(match[1]) as T
    } catch {
      // fall through
    }
  }
  // Fallback: try to parse the entire text as JSON
  try {
    return JSON.parse(text.trim()) as T
  } catch {
    return null
  }
}
