"use client"

import { createContext, useContext } from "react"
import type { SessionSlot, Workspace } from "@/hooks/use-sessions"
import type { AppSettings } from "@/hooks/use-settings"

export type SessionsContextValue = {
  // Sessions
  slots: SessionSlot[]
  createSession: (cwd: string, agentName?: string, workspaceId?: string, namespace?: string) => Promise<string | null>
  removeSession: (id: string) => Promise<void>
  sendPrompt: (id: string, text: string) => Promise<void>
  cancelPrompt: (id: string) => Promise<void>
  resolvePermission: (id: string, optionId: string | null) => Promise<void>

  // Workspaces
  workspaces: Workspace[]
  createWorkspace: (name: string) => string
  removeWorkspace: (id: string) => void
  toggleWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  pendingWorkspaceId: string
  setPendingWorkspaceId: (id: string) => void

  // Settings
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void

  // Search
  searchOpen: boolean
  openSearch: () => void
  closeSearch: () => void
}

export const SessionsContext = createContext<SessionsContextValue | null>(null)

export function useSessionsContext(): SessionsContextValue {
  const ctx = useContext(SessionsContext)
  if (!ctx) throw new Error("useSessionsContext must be used inside AiShell")
  return ctx
}
