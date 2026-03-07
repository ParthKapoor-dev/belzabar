"use client"

import { createContext, useContext } from "react"
import type { SessionSlot } from "@/hooks/use-sessions"
import type { AppSettings } from "@/hooks/use-settings"

export type SessionsContextValue = {
  slots: SessionSlot[]
  createSession: (cwd: string, agentName?: string) => Promise<string | null>
  removeSession: (id: string) => Promise<void>
  sendPrompt: (id: string, text: string) => Promise<void>
  cancelPrompt: (id: string) => Promise<void>
  resolvePermission: (id: string, optionId: string | null) => Promise<void>
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void
}

export const SessionsContext = createContext<SessionsContextValue | null>(null)

export function useSessionsContext(): SessionsContextValue {
  const ctx = useContext(SessionsContext)
  if (!ctx) throw new Error("useSessionsContext must be used inside AiShell")
  return ctx
}
