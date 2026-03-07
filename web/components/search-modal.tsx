"use client"

import { useEffect, useRef, useState, useMemo } from "react"
import { useRouter } from "next/navigation"
import { cn } from "@/lib/utils"
import type { SessionSlot } from "@/hooks/use-sessions"

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p
}

function getSnippet(slot: SessionSlot, query: string): string | null {
  const q = query.toLowerCase()
  for (const msg of slot.messages) {
    if (msg.role !== "user") continue
    const text = (msg as { role: "user"; text: string }).text
    const idx = text.toLowerCase().indexOf(q)
    if (idx >= 0) {
      const start = Math.max(0, idx - 30)
      return (start > 0 ? "…" : "") + text.slice(start, idx + 70)
    }
  }
  return null
}

export function SearchModal({
  open,
  onClose,
  slots,
}: {
  open: boolean
  onClose: () => void
  slots: SessionSlot[]
}) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery("")
      setSelectedIdx(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const source = q
      ? slots.filter(
          (s) =>
            s.cwd.toLowerCase().includes(q) ||
            s.messages.some((m) => m.role === "user" && (m as { role: "user"; text: string }).text.toLowerCase().includes(q)),
        )
      : [...slots]
    return source
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10)
      .map((slot) => ({ slot, snippet: q ? getSnippet(slot, q) : null }))
  }, [query, slots])

  useEffect(() => setSelectedIdx(0), [results])

  const select = (slot: SessionSlot) => {
    router.push(`/ai/${slot.id}`)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, results.length - 1)) }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)) }
    if (e.key === "Enter" && results[selectedIdx]) select(results[selectedIdx].slot)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
      <div
        className="relative w-full max-w-lg mx-4 bg-background border border-border shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center border-b border-border px-4">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="search sessions…"
            className="flex-1 py-3 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
          />
          <kbd className="text-[10px] text-muted-foreground/50 border border-border px-1 py-0.5">esc</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[360px] overflow-y-auto">
          {results.length === 0 ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">
              {query ? "no sessions found" : "no sessions yet"}
            </p>
          ) : (
            results.map(({ slot, snippet }, idx) => (
              <button
                key={slot.id}
                onClick={() => select(slot)}
                onMouseEnter={() => setSelectedIdx(idx)}
                className={cn(
                  "w-full px-4 py-2.5 text-left flex items-start gap-3 border-b border-border/40 last:border-0 transition-colors",
                  idx === selectedIdx ? "bg-muted/60" : "hover:bg-muted/30",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full shrink-0 mt-1.5",
                    slot.connectionStatus === "live" && !slot.isRunning
                      ? "bg-green-500"
                      : slot.isRunning
                        ? "bg-yellow-500 animate-pulse"
                        : "bg-muted-foreground/40",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-medium truncate">{basename(slot.cwd)}</p>
                    <span className="text-[10px] text-muted-foreground/50 shrink-0">
                      {new Date(slot.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{slot.cwd}</p>
                  {snippet && (
                    <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5 italic">
                      "{snippet}"
                    </p>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="px-4 py-2 border-t border-border flex items-center gap-4 text-[10px] text-muted-foreground/50">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
