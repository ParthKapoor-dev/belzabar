export const runtime = "nodejs"

import { WorkerExecutor } from "@/lib/workers/executor"
import { METHOD_SUMMARIZE_SCHEMA, METHOD_SUMMARIZE_SYSTEM } from "@/lib/workers/contracts/method-summarize"
import type { WorkerTask } from "@/lib/workers/types"

// Map from schema → system prompt.
// Add new worker contracts here as they are defined.
const SYSTEM_PROMPTS: Record<string, string> = {
  [METHOD_SUMMARIZE_SCHEMA]: METHOD_SUMMARIZE_SYSTEM,
}

const executor = new WorkerExecutor()

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { task, agentName, cwd, timeoutMs } = body as {
    task?: WorkerTask<unknown>
    agentName?: string
    cwd?: string
    timeoutMs?: number
  }

  if (!task || typeof task.schema !== "string") {
    return Response.json({ error: "task.schema is required" }, { status: 400 })
  }
  if (!cwd || typeof cwd !== "string") {
    return Response.json({ error: "cwd is required" }, { status: 400 })
  }

  const systemPrompt = SYSTEM_PROMPTS[task.schema]
  if (!systemPrompt) {
    return Response.json({ error: `Unknown worker schema: ${task.schema}` }, { status: 400 })
  }

  const result = await executor.run({
    task,
    systemPrompt,
    agentName: agentName ?? "opencode",
    cwd,
    timeoutMs,
  })

  return Response.json(result)
}
