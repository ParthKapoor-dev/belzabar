"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter, usePathname } from "next/navigation"
import { SessionSidebar } from "@/components/session-sidebar"
import { SearchModal } from "@/components/search-modal"
import { SessionsContext } from "@/lib/sessions-context"
import { useSessions, DEFAULT_WORKSPACE_ID } from "@/hooks/use-sessions"
import { useSettings } from "@/hooks/use-settings"

export function AiShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()

  const {
    slots, workspaces, initialized,
    createSession, removeSession, sendPrompt, cancelPrompt, resolvePermission,
    createWorkspace, removeWorkspace, toggleWorkspace, renameWorkspace,
  } = useSessions()
  const { settings, update: updateSettings, loaded: settingsLoaded } = useSettings()

  const [searchOpen, setSearchOpen] = useState(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState(DEFAULT_WORKSPACE_ID)
  const autoConnectFired = useRef(false)

  // Derive active session id from URL: /ai/<id>
  const segments = pathname.split("/")
  const activeId =
    segments[1] === "ai" && segments[2] && segments[2] !== "settings" && segments[2] !== "api"
      ? segments[2]
      : null

  // ─── Auto-connect ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!initialized || !settingsLoaded || autoConnectFired.current) return
    if (!settings.autoConnect || !settings.defaultCwd) return
    const hasLive = slots.some((s) => s.connectionStatus === "live")
    if (hasLive) return
    autoConnectFired.current = true
    createSession(settings.defaultCwd, settings.agentProfiles.main, DEFAULT_WORKSPACE_ID)
      .then((id) => { if (id) router.push(`/ai/${id}`) })
  }, [initialized, settingsLoaded, slots, settings, createSession, router])

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === ",") { e.preventDefault(); router.push("/ai/settings") }
      if (mod && e.key === "n") { e.preventDefault(); router.push("/ai") }
      if (mod && e.key === "k") { e.preventDefault(); setSearchOpen(true) }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [router])

  // ─── Handlers ───────────────────────────────────────────────────────────────
  const handleRemove = async (id: string) => {
    await removeSession(id)
    if (id === activeId) {
      const remaining = slots.filter((s) => s.id !== id)
      router.push(remaining.length > 0 ? `/ai/${remaining[0].id}` : "/ai")
    }
  }

  const handleNewInWorkspace = (workspaceId: string) => {
    setPendingWorkspaceId(workspaceId)
    router.push("/ai")
  }

  const isLoading = !initialized || !settingsLoaded

  if (isLoading) {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-center px-8">
          <div className="flex gap-1">
            <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:-0.3s]" />
            <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:-0.15s]" />
            <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce" />
          </div>
          <p className="text-xs text-muted-foreground">
            creating a connection to the default workspace. please wait…
          </p>
        </div>
      </div>
    )
  }

  return (
    <SessionsContext.Provider
      value={{
        slots, createSession, removeSession, sendPrompt, cancelPrompt, resolvePermission,
        workspaces, createWorkspace, removeWorkspace, toggleWorkspace, renameWorkspace,
        pendingWorkspaceId, setPendingWorkspaceId,
        settings, updateSettings,
        searchOpen, openSearch: () => setSearchOpen(true), closeSearch: () => setSearchOpen(false),
      }}
    >
      <div className="flex h-svh">
        <SessionSidebar
          slots={slots}
          workspaces={workspaces}
          activeId={activeId}
          onSelect={(id) => router.push(`/ai/${id}`)}
          onNewInWorkspace={handleNewInWorkspace}
          onRemove={handleRemove}
          onToggleWorkspace={toggleWorkspace}
          onCreateWorkspace={createWorkspace}
          onSettings={() => router.push("/ai/settings")}
          onSearch={() => setSearchOpen(true)}
        />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">{children}</div>
      </div>
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} slots={slots} />
    </SessionsContext.Provider>
  )
}
