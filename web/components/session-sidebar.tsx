"use client"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Plus, X, Gear } from "@phosphor-icons/react"
import type { SessionSlot } from "@/hooks/use-sessions"

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p
}

function StatusDot({ slot }: { slot: SessionSlot }) {
  if (slot.connecting) {
    return <span className="size-1.5 rounded-full shrink-0 bg-muted-foreground animate-pulse" />
  }
  if (slot.isRunning) {
    return <span className="size-1.5 rounded-full shrink-0 bg-yellow-500 animate-pulse" />
  }
  if (slot.connectionStatus === "disconnected") {
    return <span className="size-1.5 rounded-full shrink-0 bg-muted-foreground/50" />
  }
  return <span className="size-1.5 rounded-full shrink-0 bg-green-500 dark:bg-green-400" />
}

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
        "group relative flex items-start gap-2 px-3 py-2 cursor-pointer select-none",
        "hover:bg-muted/40 transition-colors",
        isActive && "bg-muted/50",
      )}
    >
      <StatusDot slot={slot} />

      <div className="min-w-0 flex-1 mt-px">
        <p className="text-xs font-medium truncate leading-tight">
          {slot.connecting ? "connecting…" : basename(slot.cwd)}
        </p>
        <p className="text-xs text-muted-foreground truncate leading-tight mt-0.5">{slot.cwd}</p>
        {slot.connectError && (
          <p className="text-xs text-destructive truncate mt-0.5">{slot.connectError}</p>
        )}
      </div>

      {!slot.connecting && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          disabled={slot.isRunning}
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground transition-opacity mt-px",
            "opacity-0 group-hover:opacity-100",
          )}
          title="remove session"
        >
          <X size={10} />
        </Button>
      )}
    </div>
  )
}

export function SessionSidebar({
  slots,
  activeId,
  onSelect,
  onNew,
  onRemove,
  onSettings,
}: {
  slots: SessionSlot[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRemove: (id: string) => void
  onSettings: () => void
}) {
  return (
    <aside className="w-52 shrink-0 border-r border-border flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground font-medium">sessions</span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onNew}
          title="new session"
          className="text-muted-foreground hover:text-foreground"
        >
          <Plus size={12} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {slots.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">no sessions yet</p>
        ) : (
          slots.map((slot) => (
            <SessionItem
              key={slot.id}
              slot={slot}
              isActive={slot.id === activeId}
              onSelect={() => onSelect(slot.id)}
              onRemove={() => onRemove(slot.id)}
            />
          ))
        )}
      </div>

      <div className="border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onSettings}
          title="settings"
          className="text-muted-foreground hover:text-foreground"
        >
          <Gear size={14} />
        </Button>
      </div>
    </aside>
  )
}
