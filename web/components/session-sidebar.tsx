"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Plus, X, Gear, MagnifyingGlass, CaretDown, CaretRight, Robot } from "@phosphor-icons/react"
import type { SessionSlot } from "@/hooks/use-sessions"
import { AGENT_EMOJI } from "@/lib/acp-types"
import { useAcpRegistry } from "@/lib/acp-registry"
import { ConfirmDeleteModal } from "@/components/confirm-delete-modal"

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
  onRequestRemove,
  getIcon,
}: {
  slot: SessionSlot
  isActive: boolean
  onSelect: () => void
  onRequestRemove: () => void
  getIcon: (agentName: string) => string | undefined
}) {
  const iconUrl = getIcon(slot.agentName)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      className={cn(
        "group relative flex items-center gap-2 pl-4 pr-2 py-1.5 cursor-pointer select-none",
        "hover:bg-muted/40 transition-colors",
        isActive && "bg-muted/50",
      )}
    >
      {iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={iconUrl}
          alt={slot.agentName}
          className="size-3 shrink-0 object-contain"
          onError={(e) => {
            e.currentTarget.style.display = "none"
          }}
        />
      ) : AGENT_EMOJI[slot.agentName] ? (
        <span className="size-3 shrink-0 text-[9px] flex items-center justify-center text-muted-foreground/50 leading-none">
          {AGENT_EMOJI[slot.agentName]}
        </span>
      ) : (
        <Robot size={12} className="size-3 shrink-0 text-muted-foreground/30" />
      )}
      <StatusDot slot={slot} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1">
          <p className="text-xs font-medium truncate leading-tight flex-1">
            {slot.connecting ? "connecting…" : (slot.name ?? basename(slot.cwd))}
          </p>
          <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
            {formatTime(slot.createdAt)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {slot.agentName && (
            <span className="text-[10px] text-muted-foreground/40 truncate">
              {slot.agentName}{slot.model ? ` · ${slot.model}` : ""}
            </span>
          )}
          {slot.connectionStatus === "disconnected" && (
            <span className="text-[10px] text-muted-foreground/30">(history)</span>
          )}
        </div>
        {slot.connectError && (
          <p className="text-[10px] text-destructive truncate">{slot.connectError}</p>
        )}
      </div>
      {!slot.connecting && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation()
            onRequestRemove()
          }}
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

// ─── NamespaceSection ─────────────────────────────────────────────────────────

function NamespaceSection({
  name,
  slots,
  activeId,
  onSelect,
  onRequestRemove,
  getIcon,
}: {
  name: string
  slots: SessionSlot[]
  activeId: string | null
  onSelect: (id: string) => void
  onRequestRemove: (id: string) => void
  getIcon: (agentName: string) => string | undefined
}) {
  const [collapsed, setCollapsed] = useState(false)
  const dateGroups = groupByDate(slots)
  const showDateLabels = dateGroups.length > 1

  return (
    <div>
      <div className="group flex items-center gap-1 px-2 py-1.5 hover:bg-muted/20 transition-colors">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          {collapsed ? (
            <CaretRight size={10} className="text-muted-foreground/60 shrink-0" />
          ) : (
            <CaretDown size={10} className="text-muted-foreground/60 shrink-0" />
          )}
          <span className="text-xs font-medium text-muted-foreground truncate uppercase tracking-wide">
            {name}
          </span>
          {slots.length > 0 && (
            <span className="text-[10px] text-muted-foreground/40 shrink-0">{slots.length}</span>
          )}
        </button>
      </div>

      {!collapsed && (
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
                  onRequestRemove={() => onRequestRemove(slot.id)}
                  getIcon={getIcon}
                />
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

// ─── SessionSidebar ───────────────────────────────────────────────────────────

export function SessionSidebar({
  slots,
  namespaces,
  activeId,
  onSelect,
  onNew,
  onRemove,
  onSettings,
  onSearch,
}: {
  slots: SessionSlot[]
  namespaces: string[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRemove: (id: string) => void
  onSettings: () => void
  onSearch: () => void
}) {
  const registry = useAcpRegistry()
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null)

  const getIcon = (agentName: string) => registry.get(agentName.toLowerCase())?.icon

  const handleConfirmDelete = () => {
    if (!pendingDelete) return
    onRemove(pendingDelete.id)
    setPendingDelete(null)
  }

  // Group sessions by namespace; no namespace → "general"
  const nsGroups = new Map<string, SessionSlot[]>()
  for (const slot of slots) {
    const ns = slot.namespace ?? "general"
    if (!nsGroups.has(ns)) nsGroups.set(ns, [])
    nsGroups.get(ns)!.push(slot)
  }

  // Build ordered list: API namespaces first, "general" last, any extras appended
  const ordered: string[] = [...namespaces.filter((ns) => ns !== "general"), "general"]
  for (const ns of nsGroups.keys()) {
    if (!ordered.includes(ns)) ordered.push(ns)
  }

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
            onClick={onNew}
            title="new session (⌘N)"
            className="text-muted-foreground hover:text-foreground"
          >
            <Plus size={12} />
          </Button>
        </div>
      </div>

      {/* Namespace sections */}
      <div className="flex-1 overflow-y-auto">
        {ordered.map((ns) => (
          <NamespaceSection
            key={ns}
            name={ns}
            slots={nsGroups.get(ns) ?? []}
            activeId={activeId}
            onSelect={onSelect}
            onRequestRemove={(id) => {
              const slot = slots.find((s) => s.id === id)
              if (slot) setPendingDelete({ id, name: slot.name ?? basename(slot.cwd) })
            }}
            getIcon={getIcon}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-2 py-1.5">
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

      <ConfirmDeleteModal
        open={pendingDelete !== null}
        sessionName={pendingDelete?.name ?? ""}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </aside>
  )
}
