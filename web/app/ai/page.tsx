"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { useSessionsContext } from "@/lib/sessions-context"

export default function AiPage() {
  const router = useRouter()
  const { createSession, settings, pendingWorkspaceId } = useSessionsContext()
  const [cwd, setCwd] = useState("")
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (settings.defaultCwd && !cwd) setCwd(settings.defaultCwd)
  }, [settings.defaultCwd]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStart = async () => {
    const trimmed = cwd.trim()
    if (!trimmed) return
    setConnecting(true)
    setError(null)
    const id = await createSession(trimmed, settings.agentProfiles.main, pendingWorkspaceId)
    if (id) {
      router.push(`/ai/${id}`)
    } else {
      setError("Failed to start session")
      setConnecting(false)
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8 h-full">
      <div className="w-full max-w-sm space-y-6">
        <div>
          <h1 className="text-sm font-medium">new session</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            connect to opencode via agent client protocol
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">working directory</label>
          <input
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleStart()}
            placeholder="/path/to/project"
            autoFocus
            className="w-full border border-border bg-transparent px-2.5 py-1.5 text-xs placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring/50"
          />
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <Button
          onClick={handleStart}
          disabled={connecting || !cwd.trim()}
          className="w-full"
          size="sm"
        >
          {connecting ? "connecting…" : "start session"}
        </Button>
      </div>
    </div>
  )
}
