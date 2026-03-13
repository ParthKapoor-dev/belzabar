"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { useSessionsContext } from "@/lib/sessions-context"
import { AGENT_REGISTRY } from "@/lib/acp-types"

const AGENT_OPTIONS = Object.keys(AGENT_REGISTRY)

export default function AiPage() {
  const router = useRouter()
  const { createSession, settings, pendingWorkspaceId } = useSessionsContext()
  const [cwd, setCwd] = useState("")
  const [namespace, setNamespace] = useState<string>("")
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [agent, setAgent] = useState<string>("")
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (settings.defaultCwd && !cwd) setCwd(settings.defaultCwd)
  }, [settings.defaultCwd]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (settings.agentProfiles.main && !agent) setAgent(settings.agentProfiles.main)
  }, [settings.agentProfiles.main]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch("/ai/api/namespaces")
      .then((r) => r.json())
      .then((data: { namespaces: string[] }) => setNamespaces(data.namespaces))
      .catch(() => {})
  }, [])

  const handleStart = async () => {
    const trimmed = cwd.trim()
    if (!trimmed) return
    setConnecting(true)
    setError(null)
    const id = await createSession(trimmed, agent, pendingWorkspaceId, namespace || undefined)
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
            connect to {agent || "…"} via agent client protocol
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">agent</label>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_OPTIONS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAgent(a)}
                  className={`px-2.5 py-1 text-xs border transition-colors uppercase tracking-wide ${
                    agent === a
                      ? "border-ring bg-ring/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
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

          {namespaces.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">namespace</label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setNamespace("")}
                  className={`px-2.5 py-1 text-xs border transition-colors ${
                    namespace === ""
                      ? "border-ring bg-ring/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  none
                </button>
                {namespaces.map((ns) => (
                  <button
                    key={ns}
                    type="button"
                    onClick={() => setNamespace(ns)}
                    className={`px-2.5 py-1 text-xs border transition-colors uppercase tracking-wide ${
                      namespace === ns
                        ? "border-ring bg-ring/10 text-foreground"
                        : "border-border text-muted-foreground hover:border-muted-foreground"
                    }`}
                  >
                    {ns}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground/60">
                injects domain context into the agent's first message
              </p>
            </div>
          )}
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
