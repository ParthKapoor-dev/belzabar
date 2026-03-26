"use client"

import { useEffect, useRef, useState, useMemo, useCallback } from "react"
import { cn } from "@/lib/utils"

const ENVS = ["nsm-dev", "nsm-qa", "nsm-uat"] as const
type Env = (typeof ENVS)[number]

interface AdMatch {
  type: "method" | "category"
  score: number
  uuid: string
  methodName?: string
  aliasName?: string
  categoryName?: string
  state?: string
  url?: string
  referenceId?: string
  name?: string
  label?: string
  methodCount?: number
}

interface PdMatch {
  type: "page" | "component"
  score: number
  id: string
  name: string
  url: string
  relativeRoute?: string
  referenceId?: string
  status?: string
}

type SearchMatch = (AdMatch & { _kind: "ad" }) | (PdMatch & { _kind: "pd" })

interface SearchResults {
  ad: {
    matches: AdMatch[]
    cache: { source: string; methodCount: number; categoryCount: number } | null
    error?: string
  }
  pd: {
    matches: PdMatch[]
    cache: { source: string; pageCount: number; componentCount: number } | null
    error?: string
  }
}

const TYPE_STYLES: Record<string, string> = {
  method: "text-primary border-primary/30 bg-primary/5",
  category: "text-blue-400 border-blue-400/30 bg-blue-400/5",
  page: "text-amber-400 border-amber-400/30 bg-amber-400/5",
  component: "text-purple-400 border-purple-400/30 bg-purple-400/5",
}

function getMatchName(item: SearchMatch): string {
  if (item._kind === "ad") {
    return item.type === "method" ? (item.methodName ?? item.aliasName ?? item.uuid) : (item.name ?? item.label ?? item.uuid)
  }
  return item.name
}

function getMatchSecondary(item: SearchMatch): string {
  if (item._kind === "ad") {
    if (item.type === "method") {
      const parts: string[] = []
      if (item.aliasName && item.aliasName !== item.methodName) parts.push(item.aliasName)
      if (item.categoryName) parts.push(item.categoryName)
      return parts.join(" · ")
    }
    if (item.type === "category" && item.methodCount != null) {
      return `${item.methodCount} methods`
    }
    return ""
  }
  if (item.type === "page" && item.relativeRoute) return item.relativeRoute
  return item.status ?? ""
}

function getMatchId(item: SearchMatch): string {
  if (item._kind === "ad") return item.uuid
  return item.id
}

function getMatchUrl(item: SearchMatch): string | null {
  if (item._kind === "ad") return item.url ?? null
  return item.url ?? null
}

export function UnifiedSearchModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [env, setEnv] = useState<Env>("nsm-dev")
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("")
      setDebouncedQuery("")
      setResults(null)
      setSelectedIdx(0)
      setLoading(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Debounce query
  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setDebouncedQuery("")
      return
    }
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  // Fetch results
  useEffect(() => {
    if (!debouncedQuery) {
      setResults(null)
      setLoading(false)
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)

    fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: debouncedQuery, env, limit: 20 }),
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data: SearchResults) => {
        if (!controller.signal.aborted) {
          setResults(data)
          setLoading(false)
          setSelectedIdx(0)
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [debouncedQuery, env])

  // Flatten and sort results by score
  const flatResults = useMemo<SearchMatch[]>(() => {
    if (!results) return []
    const items: SearchMatch[] = [
      ...results.ad.matches.map((m) => ({ ...m, _kind: "ad" as const })),
      ...results.pd.matches.map((m) => ({ ...m, _kind: "pd" as const })),
    ]
    items.sort((a, b) => b.score - a.score)
    return items
  }, [results])

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: "nearest" })
  }, [selectedIdx])

  const cycleEnv = useCallback(() => {
    setEnv((current) => {
      const idx = ENVS.indexOf(current)
      return ENVS[(idx + 1) % ENVS.length]
    })
  }, [])

  const openSelected = useCallback(() => {
    const item = flatResults[selectedIdx]
    if (!item) return
    const url = getMatchUrl(item)
    if (url) window.open(url, "_blank")
  }, [flatResults, selectedIdx])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose()
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, flatResults.length - 1))
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      openSelected()
      return
    }
    if (e.key === "Tab") {
      e.preventDefault()
      cycleEnv()
      return
    }
  }

  if (!open) return null

  const hasQuery = query.trim().length >= 2
  const noResults = hasQuery && !loading && flatResults.length === 0

  // Cache status text
  const cacheStatus = results
    ? [
        results.ad.cache
          ? `ad: ${results.ad.cache.methodCount} methods (${results.ad.cache.source})`
          : results.ad.error
            ? `ad: ${results.ad.error}`
            : null,
        results.pd.cache
          ? `pd: ${results.pd.cache.pageCount} pages, ${results.pd.cache.componentCount} components (${results.pd.cache.source})`
          : results.pd.error
            ? `pd: ${results.pd.error}`
            : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
      <div
        className="relative w-full max-w-xl mx-4 bg-background border border-border shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2 fade-in duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-2 border-b border-border px-4">
          <svg
            className="size-3.5 text-muted-foreground/50 shrink-0"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="6.5" cy="6.5" r="5" />
            <path d="M10.5 10.5L14.5 14.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="search methods, pages, components..."
            spellCheck={false}
            className="flex-1 py-3 text-sm bg-transparent outline-none placeholder:text-muted-foreground/50"
          />
          <div className="flex items-center gap-1.5 shrink-0">
            {ENVS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setEnv(e)}
                className={cn(
                  "px-1.5 py-0.5 text-[10px] border transition-colors uppercase tracking-wide leading-none",
                  env === e
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground/40 hover:text-muted-foreground hover:border-muted-foreground/50",
                )}
              >
                {e.replace("nsm-", "")}
              </button>
            ))}
          </div>
          <kbd className="text-[10px] text-muted-foreground/40 border border-border/60 px-1 py-0.5 leading-none shrink-0 ml-1">
            esc
          </kbd>
        </div>

        {/* Status bar */}
        <div className="px-4 py-1.5 border-b border-border/50 flex items-center min-h-[24px]">
          {loading ? (
            <span className="text-[10px] text-muted-foreground/50 flex items-center gap-1.5">
              <span className="inline-flex gap-0.5">
                <span className="size-1 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:-0.3s]" />
                <span className="size-1 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:-0.15s]" />
                <span className="size-1 rounded-full bg-muted-foreground/40 animate-bounce" />
              </span>
              searching...
            </span>
          ) : cacheStatus ? (
            <span className="text-[10px] text-muted-foreground/40 truncate">{cacheStatus}</span>
          ) : (
            <span className="text-[10px] text-muted-foreground/30">type to search</span>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[400px] overflow-y-auto">
          {!hasQuery && !loading && (
            <div className="px-4 py-10 text-center">
              <p className="text-xs text-muted-foreground/40">search AD methods, PD pages & components</p>
              <p className="text-[10px] text-muted-foreground/25 mt-1.5">
                try a method name, page name, UUID, or route
              </p>
            </div>
          )}

          {noResults && (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-muted-foreground/50">
                no matches for &ldquo;{query.trim()}&rdquo;
              </p>
            </div>
          )}

          {flatResults.map((item, idx) => {
            const name = getMatchName(item)
            const secondary = getMatchSecondary(item)
            const id = getMatchId(item)
            const url = getMatchUrl(item)

            return (
              <button
                key={`${item._kind}-${id}-${idx}`}
                onClick={() => url && window.open(url, "_blank")}
                onMouseEnter={() => setSelectedIdx(idx)}
                className={cn(
                  "w-full px-4 py-2.5 text-left flex items-start gap-3 border-b border-border/30 last:border-0 transition-colors",
                  idx === selectedIdx ? "bg-muted/60" : "hover:bg-muted/30",
                )}
              >
                {/* Type badge */}
                <span
                  className={cn(
                    "text-[9px] uppercase tracking-wider font-semibold border px-1.5 py-0.5 leading-none shrink-0 mt-0.5",
                    TYPE_STYLES[item.type] ?? "text-muted-foreground border-border",
                  )}
                >
                  {item.type === "method" ? "mth" : item.type === "category" ? "cat" : item.type === "component" ? "cmp" : "pg"}
                </span>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-medium truncate">{name}</p>
                    <span className="text-[10px] text-muted-foreground/30 shrink-0 tabular-nums">
                      {item.score}
                    </span>
                  </div>
                  {secondary && (
                    <p className="text-[11px] text-muted-foreground/60 truncate mt-0.5">{secondary}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground/30 font-mono truncate mt-0.5">{id}</p>
                </div>
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border flex items-center gap-4 text-[10px] text-muted-foreground/40">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-mono">↵</kbd> open
          </span>
          <span>
            <kbd className="font-mono">tab</kbd> switch env
          </span>
          <span>
            <kbd className="font-mono">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
