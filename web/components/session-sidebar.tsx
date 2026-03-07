"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Plus, X, Gear, MagnifyingGlass, CaretDown, CaretRight, FolderPlus } from "@phosphor-icons/react"
import type { SessionSlot, Workspace } from "@/hooks/use-sessions"

// ─── Time/date helpers ─────────────────────────────────────────────────────────

function formatTime(isoStr: string): string {
  const d = new Date(isoStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return "now"
  if (diffMins < 60) return `${diffMins}m`
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function dateLabel(isoStr: string): string {
  const d = new Date(isoStr)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return "today"
  if (d.toDateString() === yesterday.toDateString()) return "yesterday"
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
}

function groupByDate(slots: SessionSlot[]): Array<{ label: string; slots: SessionSlot[] }> {
  const sorted = [...slots].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const groups: Array<{ label: string; slots: SessionSlot[] }> = []
  for (const slot of sorted) {
    const label = dateLabel(slot.createdAt)
    const existing = groups.find((g) => g.label === label)
    if (existing) existing.slots.push(slot)
    else groups.push({ label, slots: [slot] })
  }
  return groups
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p
}

// ─── StatusDot ────────────────────────────────────────────────────────────────

function StatusDot({ slot }: { slot: SessionSlot }) {
  if (slot.connecting)
    return <span className="size-1.5 rounded-full shrink-0 bg-muted-foreground animate-pulse" />
  if (slot.isRunning)
    return <span className="size-1.5 rounded-full shrink-0 bg-yellow-500 animate-pulse" />
  if (slot.connectionStatus === "disconnected")
    return <span className="size-1.5 rounded-full shrink-0 bg-muted-foreground/40" />
  return <span className="size-1.5 rounded-full shrink-0 bg-green-500 dark:bg-green-400" />
}

// ─── SessionItem ──────────────────────────────────────────────────────────────

function SessionItem({
  slot,
  isActive,
  onSelect,
  onRemove,
}: {
  slot: SessionSlot
  isActive: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      className={cn(
        "group relative flex items-center gap-2 pl-6 pr-2 py-1.5 cursor-pointer select-none",
        "hover:bg-muted/40 transition-colors",
        isActive && "bg-muted/50",
      )}
    >
      <StatusDot slot={slot} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1">
          <p className="text-xs font-medium truncate leading-tight flex-1">
            {slot.connecting ? "connecting…" : basename(slot.cwd)}
          </p>
          <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
            {formatTime(slot.createdAt)}
          </span>
        </div>
        {slot.connectError && (
          <p className="text-[10px] text-destructive truncate">{slot.connectError}</p>
        )}
      </div>
      {!slot.connecting && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          disabled={slot.isRunning}
          className="shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
          title="remove session"
        >
          <X size={10} />
        </Button>
      )}
    </div>
  )
}

// ─── WorkspaceSection ─────────────────────────────────────────────────────────

function WorkspaceSection({
  workspace,
  slots,
  activeId,
  onSelect,
  onRemove,
  onNewSession,
  onToggle,
}: {
  workspace: Workspace
  slots: SessionSlot[]
  activeId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onNewSession: () => void
  onToggle: () => void
}) {
  const dateGroups = groupByDate(slots)
  const showDateLabels = dateGroups.length > 1

  return (
    <div>
      {/* Workspace header */}
      <div className="group flex items-center gap-1 px-2 py-1.5 hover:bg-muted/20 transition-colors">
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          {workspace.collapsed
            ? <CaretRight size={10} className="text-muted-foreground/60 shrink-0" />
            : <CaretDown size={10} className="text-muted-foreground/60 shrink-0" />
          }
          <span className="text-xs font-medium text-muted-foreground truncate">
            {workspace.name}
          </span>
          {slots.length > 0 && (
            <span className="text-[10px] text-muted-foreground/40 shrink-0">
              {slots.length}
            </span>
          )}
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onNewSession}
          title={`new session in ${workspace.name}`}
          className="text-muted-foreground/50 hover:text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Plus size={10} />
        </Button>
      </div>

      {/* Sessions grouped by date */}
      {!workspace.collapsed && (
        <>
          {slots.length === 0 && (
            <p className="pl-6 pr-3 py-1.5 text-[11px] text-muted-foreground/50">no sessions</p>
          )}
          {dateGroups.map((group) => (
            <div key={group.label}>
              {showDateLabels && (
                <div className="flex items-center gap-2 pl-6 pr-3 py-1">
                  <span className="text-[10px] text-muted-foreground/40 uppercase tracking-wider whitespace-nowrap">
                    {group.label}
                  </span>
                  <div className="flex-1 h-px bg-border/40" />
                </div>
              )}
              {group.slots.map((slot) => (
                <SessionItem
                  key={slot.id}
                  slot={slot}
                  isActive={slot.id === activeId}
                  onSelect={() => onSelect(slot.id)}
                  onRemove={() => onRemove(slot.id)}
                />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

// ─── NewWorkspaceInput ────────────────────────────────────────────────────────

function NewWorkspaceInput({ onCreate, onCancel }: { onCreate: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("")
  return (
    <div className="px-3 py-2 flex items-center gap-1.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) onCreate(name.trim())
          if (e.key === "Escape") onCancel()
        }}
        placeholder="workspace name"
        className="flex-1 min-w-0 text-xs bg-transparent border border-border px-1.5 py-0.5 outline-none focus:border-ring"
      />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onCancel}
        className="text-muted-foreground shrink-0"
      >
        <X size={10} />
      </Button>
    </div>
  )
}

// ─── SessionSidebar ───────────────────────────────────────────────────────────

export function SessionSidebar({
  slots,
  workspaces,
  activeId,
  onSelect,
  onNewInWorkspace,
  onRemove,
  onToggleWorkspace,
  onCreateWorkspace,
  onSettings,
  onSearch,
}: {
  slots: SessionSlot[]
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string) => void
  onNewInWorkspace: (workspaceId: string) => void
  onRemove: (id: string) => void
  onToggleWorkspace: (id: string) => void
  onCreateWorkspace: (name: string) => string
  onSettings: () => void
  onSearch: () => void
}) {
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)

  return (
    <aside className="w-52 shrink-0 border-r border-border flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground font-medium">sessions</span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onSearch}
            title="search sessions (⌘K)"
            className="text-muted-foreground hover:text-foreground"
          >
            <MagnifyingGlass size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setCreatingWorkspace(true)}
            title="new workspace"
            className="text-muted-foreground hover:text-foreground"
          >
            <FolderPlus size={12} />
          </Button>
        </div>
      </div>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto">
        {workspaces.map((ws) => (
          <WorkspaceSection
            key={ws.id}
            workspace={ws}
            slots={slots.filter((s) => s.workspaceId === ws.id)}
            activeId={activeId}
            onSelect={onSelect}
            onRemove={onRemove}
            onNewSession={() => onNewInWorkspace(ws.id)}
            onToggle={() => onToggleWorkspace(ws.id)}
          />
        ))}

        {creatingWorkspace && (
          <NewWorkspaceInput
            onCreate={(name) => { onCreateWorkspace(name); setCreatingWorkspace(false) }}
            onCancel={() => setCreatingWorkspace(false)}
          />
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-2 py-1.5 flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onSettings}
          title="settings (⌘,)"
          className="text-muted-foreground hover:text-foreground"
        >
          <Gear size={14} />
        </Button>
      </div>
    </aside>
  )
}
