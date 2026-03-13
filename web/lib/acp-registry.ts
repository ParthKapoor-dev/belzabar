"use client"

import { useState, useEffect } from "react"

export type AcpAgentEntry = {
  id: string
  name: string
  icon?: string
}

let _cache: Map<string, AcpAgentEntry> | null = null
let _promise: Promise<void> | null = null

export function useAcpRegistry(): Map<string, AcpAgentEntry> {
  const [registry, setRegistry] = useState<Map<string, AcpAgentEntry>>(() => _cache ?? new Map())

  useEffect(() => {
    if (_cache) return
    if (!_promise) {
      _promise = fetch("/ai/api/acp-registry")
        .then((r) => r.json() as Promise<{ agents: AcpAgentEntry[] }>)
        .then(({ agents }) => {
          _cache = new Map(agents.map((a) => [a.id.toLowerCase(), a]))
          setRegistry(new Map(_cache))
        })
        .catch(() => {
          _cache = new Map()
        })
    } else {
      void _promise.then(() => {
        if (_cache) setRegistry(new Map(_cache))
      })
    }
  }, [])

  return registry
}
