"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { useSessionsContext } from "@/lib/sessions-context"
import { AGENT_REGISTRY, AGENT_EMOJI, AGENT_MODELS } from "@/lib/acp-types"

const AGENT_OPTIONS = Object.keys(AGENT_REGISTRY)
const DEFAULT_WORKSPACE_ID = "default"

export default function AiPage() {
  const router = useRouter()
  const { createSession, settings } = useSessionsContext()
  const [cwd, setCwd] = useState(settings.defaultCwd || "")
  const [namespace, setNamespace] = useState<string>("")
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [namespacesLoaded, setNamespacesLoaded] = useState(false)
  const initialAgent = settings.agentProfiles.main || ""
  const [agent, setAgent] = useState(initialAgent)
  const [model, setModel] = useState((AGENT_MODELS[initialAgent] ?? [])[0] ?? "")
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSetAgent = (a: string) => {
    setAgent(a)
    setModel((AGENT_MODELS[a] ?? [])[0] ?? "")
  }

  // Fetch namespaces and auto-select "nsm" (or first available)
  useEffect(() => {
    fetch("/ai/api/namespaces")
      .then((r) => r.json())
      .then((data: { namespaces: string[] }) => {
        setNamespaces(data.namespaces)
        if (data.namespaces.length > 0) {
          const nsm = data.namespaces.find((ns) => ns.toLowerCase() === "nsm")
          setNamespace(nsm ?? data.namespaces[0])
        }
      })
      .catch(() => {})
      .finally(() => setNamespacesLoaded(true))
  }, [])

  const handleStart = async () => {
    const trimmed = cwd.trim()
    if (!trimmed) return
    setConnecting(true)
    setError(null)
    const id = await createSession(trimmed, agent, DEFAULT_WORKSPACE_ID, namespace || undefined, model || undefined)
    if (id) {
      router.push(`/ai/${id}`)
    } else {
      setError("Failed to start session")
      setConnecting(false)
    }
  }

  const modelPresets = AGENT_MODELS[agent] ?? []

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
          {/* Agent selector */}
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">agent</label>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_OPTIONS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => handleSetAgent(a)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs border transition-colors ${
                    agent === a
                      ? "border-ring bg-ring/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-muted-foreground"
                  }`}
                >
                  <span className="text-[10px] opacity-70">{AGENT_EMOJI[a] ?? "◆"}</span>
                  <span className="uppercase tracking-wide">{a}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Model selector */}
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">model</label>
            {modelPresets.length > 0 ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {modelPresets.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModel(m)}
                      className={`px-2.5 py-1 text-xs border transition-colors ${
                        model === m
                          ? "border-ring bg-ring/10 text-foreground"
                          : "border-border text-muted-foreground hover:border-muted-foreground"
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="or type a model name…"
                  className="w-full border border-border bg-transparent px-2.5 py-1.5 text-xs placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring/50"
                />
              </div>
            ) : (
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="optional model name"
                className="w-full border border-border bg-transparent px-2.5 py-1.5 text-xs placeholder:text-muted-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring/50"
              />
            )}
          </div>

          {/* Working directory */}
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

          {/* Namespace selector */}
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">namespace</label>
            {!namespacesLoaded ? (
              <p className="text-[11px] text-muted-foreground/50">loading…</p>
            ) : namespaces.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/50">no namespaces available</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
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
                  injects domain context into the agent&apos;s first message
                </p>
              </>
            )}
          </div>
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
