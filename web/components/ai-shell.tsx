"use client"

import { useRouter, usePathname } from "next/navigation"
import { SessionSidebar } from "@/components/session-sidebar"
import { SessionsContext } from "@/lib/sessions-context"
import { useSessions } from "@/hooks/use-sessions"
import { useSettings } from "@/hooks/use-settings"

export function AiShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { slots, createSession, removeSession, sendPrompt, cancelPrompt, resolvePermission } =
    useSessions()
  const { settings, update: updateSettings } = useSettings()

  // Derive active session id from URL: /ai/<id>
  const segments = pathname.split("/")
  const activeId =
    segments[1] === "ai" && segments[2] && segments[2] !== "settings" && segments[2] !== "api"
      ? segments[2]
      : null

  const handleRemove = async (id: string) => {
    await removeSession(id)
    // If we removed the active session, navigate to /ai
    if (id === activeId) {
      const remaining = slots.filter((s) => s.id !== id)
      if (remaining.length > 0) {
        router.push(`/ai/${remaining[0].id}`)
      } else {
        router.push("/ai")
      }
    }
  }

  return (
    <SessionsContext.Provider
      value={{ slots, createSession, removeSession, sendPrompt, cancelPrompt, resolvePermission, settings, updateSettings }}
    >
      <div className="flex h-svh">
        <SessionSidebar
          slots={slots}
          activeId={activeId}
          onSelect={(id) => router.push(`/ai/${id}`)}
          onNew={() => router.push("/ai")}
          onRemove={handleRemove}
          onSettings={() => router.push("/ai/settings")}
        />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">{children}</div>
      </div>
    </SessionsContext.Provider>
  )
}
