"use client"

import { useState, useEffect, useCallback } from "react"

export type AppSettings = {
  defaultCwd: string
  agentProfiles: {
    main: string
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultCwd: "/home/parth/code/sandbox/belz-ai",
  agentProfiles: {
    main: "opencode",
  },
}

const STORAGE_KEY = "ai:settings"

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSettings>
        setSettings({ ...DEFAULT_SETTINGS, ...parsed })
      }
    } catch {
      // malformed — use defaults
    }
  }, [])

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // quota — skip
      }
      return next
    })
  }, [])

  return { settings, update }
}
