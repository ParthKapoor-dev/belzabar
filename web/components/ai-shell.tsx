"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter, usePathname } from "next/navigation"
import { SessionSidebar } from "@/components/session-sidebar"
import { SearchModal } from "@/components/search-modal"
import { SessionsContext } from "@/lib/sessions-context"
import { useSessions } from "@/hooks/use-sessions"
import { useSettings } from "@/hooks/use-settings"

export function AiShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()

  const {
    slots,
    initialized,
    createSession,
    removeSession,
    sendPrompt,
    cancelPrompt,
    resolvePermission,
    createWorkspace,
    removeWorkspace,
    toggleWorkspace,
    renameWorkspace,
  } = useSessions()
  const { settings, update: updateSettings, loaded: settingsLoaded } = useSettings()

  const [searchOpen, setSearchOpen] = useState(false)
  const [namespaces, setNamespaces] = useState<string[]>([])
  const reconnectFired = useRef(false)

  // Derive active session id from URL: /ai/<id>
  const segments = pathname.split("/")
  const activeId =
    segments[1] === "ai" && segments[2] && segments[2] !== "settings" && segments[2] !== "api"
      ? segments[2]
      : null

  // Fetch namespaces once
  useEffect(() => {
    fetch("/ai/api/namespaces")
      .then((r) => r.json())
      .then((data: { namespaces: string[] }) => setNamespaces(data.namespaces))
      .catch(() => {})
  }, [])

  // Task 9: After reconciliation, if on /ai and live sessions exist, navigate to the first live one
  useEffect(() => {
    if (!initialized || reconnectFired.current) return
    reconnectFired.current = true
    if (pathname !== "/ai") return
    const firstLive = slots.find((s) => s.connectionStatus === "live")
    if (firstLive) router.push(`/ai/${firstLive.id}`)
  }, [initialized]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === ",") {
        e.preventDefault()
        router.push("/ai/settings")
      }
      if (mod && e.key === "n") {
        e.preventDefault()
        router.push("/ai")
      }
      if (mod && e.key === "a") {
        e.preventDefault()
        router.push("/ai")
      }
      if (mod && e.key === "k") {
        e.preventDefault()
        setSearchOpen(true)
      }
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

  const isLoading = !initialized || !settingsLoaded

  if (isLoading) {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        <div className="flex gap-1">
          <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:-0.3s]" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:-0.15s]" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-bounce" />
        </div>
      </div>
    )
  }

  return (
    <SessionsContext.Provider
      value={{
        slots,
        createSession,
        removeSession,
        sendPrompt,
        cancelPrompt,
        resolvePermission,
        workspaces: [],
        createWorkspace,
        removeWorkspace,
        toggleWorkspace,
        renameWorkspace,
        settings,
        updateSettings,
        searchOpen,
        openSearch: () => setSearchOpen(true),
        closeSearch: () => setSearchOpen(false),
      }}
    >
      <div className="flex h-svh">
        <SessionSidebar
          slots={slots}
          namespaces={namespaces}
          activeId={activeId}
          onSelect={(id) => router.push(`/ai/${id}`)}
          onNew={() => router.push("/ai")}
          onRemove={handleRemove}
          onSettings={() => router.push("/ai/settings")}
          onSearch={() => setSearchOpen(true)}
        />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">{children}</div>
      </div>
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} slots={slots} />
    </SessionsContext.Provider>
  )
}
