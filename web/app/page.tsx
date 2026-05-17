"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import Link from "next/link"
import { parseCurl } from "@/lib/parse-curl"
import { UnifiedSearchModal } from "@/components/unified-search-modal"

type Toast = { text: string; ok: boolean; key: number }

const MODULES = [
  {
    href: "/curl",
    icon: "⌘",
    iconColor: "text-primary",
    hoverBorder: "hover:border-primary/50",
    hoverBg: "hover:bg-primary/5",
    label: "curl → AD",
    description: "Paste a curl, URL, id or name to open AD/PD",
    hint: "ctrl+v",
  },
  {
    href: "/releases",
    icon: "⎈",
    iconColor: "text-primary",
    hoverBorder: "hover:border-primary/50",
    hoverBg: "hover:bg-primary/5",
    label: "Releases",
    description: "Release audits — collisions & promotion tracking",
    hint: "",
  },
] as const

const SEARCH_CARD = {
  icon: "⌕",
  iconColor: "text-primary",
  hoverBorder: "hover:border-primary/50",
  hoverBg: "hover:bg-primary/5",
  label: "Search",
  description: "Find AD methods, PD pages & components",
  hint: "ctrl+k",
}

const ENVS = ["nsm-dev", "nsm-qa", "nsm-uat", "nsm-stage"] as const
type Env = (typeof ENVS)[number]

type VinResult = {
  direction: "vin" | "appId"
  values: string[]
  ids: string[]
  rowCount: number
  env: string
  durationMs?: number
}

// VIN: 17 alphanumeric, no I/O/Q. Application id: 32 hex.
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/
const APP_ID_PATTERN = /^[a-f0-9]{32}$/i

type LookupDirection = "vin" | "appId" | "unknown"

function detectDirection(value: string): LookupDirection {
  const trimmed = value.trim()
  if (VIN_PATTERN.test(trimmed.toUpperCase())) return "vin"
  if (APP_ID_PATTERN.test(trimmed)) return "appId"
  return "unknown"
}

export default function Home() {
  const [toast, setToast] = useState<Toast | null>(null)
  const [toastTimer, setToastTimer] = useState<ReturnType<typeof setTimeout> | null>(null)

  // VIN ↔ Application-id lookup state
  const [lookupInput, setLookupInput] = useState("")
  const [lookupEnv, setLookupEnv] = useState<Env>("nsm-dev")
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupResult, setLookupResult] = useState<VinResult | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

  // Guards the paste handler against re-entry while a resolve request is in flight.
  const resolvingRef = useRef(false)

  const lookupDirection = detectDirection(lookupInput)

  const showToast = useCallback((text: string, ok: boolean) => {
    if (toastTimer) clearTimeout(toastTimer)
    setToast({ text, ok, key: Date.now() })
    const t = setTimeout(() => setToast(null), 2800)
    setToastTimer(t)
  }, [toastTimer])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === "k") {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [])

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) return

      const text = e.clipboardData?.getData("text") ?? ""
      if (!text.trim()) return

      // Fast path: an AD curl carries the form-autofill body — open directly.
      const { result } = parseCurl(text)
      if (result) {
        window.open(result.targetUrl, "_blank")
        showToast(`opened · ${result.uuid.slice(0, 8)}…`, true)
        return
      }

      // Fallback: resolve anything `belz ad show` / `belz pd show` accepts.
      if (resolvingRef.current) return
      const trimmed = text.trim()
      // Only attempt a resolve for things that plausibly identify an item —
      // a URL, a hex id, or a short name — to avoid firing on every stray paste.
      const looksResolvable =
        /^https?:\/\//i.test(trimmed) ||
        /^[0-9a-f]{8,}$/i.test(trimmed) ||
        /^[\w .:/-]{2,80}$/.test(trimmed)
      if (!looksResolvable) return

      resolvingRef.current = true
      showToast("resolving…", true)
      try {
        const res = await fetch("/api/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: trimmed, env: lookupEnv }),
        })
        const data = await res.json()
        if (res.ok && data.resolved) {
          window.open(data.editUrl, "_blank")
          showToast(`opened · ${data.label}`, true)
        } else if (!res.ok) {
          showToast(data.error ?? "Resolve failed", false)
        } else {
          showToast(data.reason ?? "No match found", false)
        }
      } catch {
        showToast("Resolve request failed", false)
      } finally {
        resolvingRef.current = false
      }
    }

    document.addEventListener("paste", handlePaste)
    return () => document.removeEventListener("paste", handlePaste)
  }, [showToast, lookupEnv])

  const handleLookup = async () => {
    const trimmed = lookupInput.trim()
    if (!trimmed) return
    if (lookupDirection === "unknown") {
      setLookupError("Enter a 17-char VIN or a 32-hex application id.")
      return
    }
    setLookupLoading(true)
    setLookupResult(null)
    setLookupError(null)
    try {
      const res = await fetch("/api/vin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: trimmed, env: lookupEnv }),
      })
      const data = await res.json()
      if (!res.ok) {
        setLookupError(data.error ?? "Lookup failed")
      } else {
        setLookupResult(data as VinResult)
      }
    } catch {
      setLookupError("Request failed")
    } finally {
      setLookupLoading(false)
    }
  }

  const copyId = (id: string) => {
    navigator.clipboard.writeText(id)
    setCopied(id)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-mono flex flex-col select-none">
      {/* Header */}
      <header className="border-b border-border px-6 h-11 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 bg-primary" />
          <span className="text-sm font-semibold tracking-tight">belzabar</span>
        </div>
        <span className="text-[10px] text-muted-foreground uppercase tracking-widest hidden sm:block">
          internal tooling
        </span>
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 gap-10 py-12">
        {/* Wordmark */}
        <div className="text-center space-y-1.5">
          <h1 className="text-3xl font-bold tracking-tighter">belzabar</h1>
          <p className="text-xs text-muted-foreground">nsm platform · devtools</p>
        </div>

        {/* Module cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-xl">
          {MODULES.map((mod) => (
            <Link
              key={mod.href}
              href={mod.href}
              className={`group border border-border ${mod.hoverBorder} ${mod.hoverBg} transition-all duration-100 p-5 flex flex-col gap-4`}
            >
              <div className="flex items-start justify-between">
                <span className={`text-xl leading-none ${mod.iconColor}`}>{mod.icon}</span>
                <span className="text-[10px] text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors font-mono">
                  {mod.hint}
                </span>
              </div>
              <div className="space-y-0.5">
                <div className="text-sm font-semibold tracking-tight">{mod.label}</div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">{mod.description}</div>
              </div>
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className={`group border border-border ${SEARCH_CARD.hoverBorder} ${SEARCH_CARD.hoverBg} transition-all duration-100 p-5 flex flex-col gap-4 text-left`}
          >
            <div className="flex items-start justify-between">
              <span className={`text-xl leading-none ${SEARCH_CARD.iconColor}`}>{SEARCH_CARD.icon}</span>
              <span className="text-[10px] text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors font-mono">
                {SEARCH_CARD.hint}
              </span>
            </div>
            <div className="space-y-0.5">
              <div className="text-sm font-semibold tracking-tight">{SEARCH_CARD.label}</div>
              <div className="text-[11px] text-muted-foreground leading-relaxed">{SEARCH_CARD.description}</div>
            </div>
          </button>
        </div>

        {/* VIN ↔ Application lookup */}
        <div className="w-full max-w-xl border border-border p-5 space-y-4">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
              VIN ↔ Application lookup
            </span>
            {lookupResult && (
              <span className="text-[10px] text-muted-foreground/50">
                {lookupResult.rowCount} result{lookupResult.rowCount !== 1 ? "s" : ""} · {lookupResult.durationMs}ms
              </span>
            )}
          </div>

          {/* Direction hint */}
          <div className="text-[10px] text-muted-foreground/50">
            {lookupInput.trim().length === 0
              ? "Enter a VIN (17 chars) or an application id (32 hex)."
              : lookupDirection === "vin"
                ? "VIN → application ids"
                : lookupDirection === "appId"
                  ? "application id → VINs"
                  : "Not a VIN or application id"}
          </div>

          {/* Input */}
          <input
            type="text"
            value={lookupInput}
            onChange={(e) => {
              setLookupInput(e.target.value)
              setLookupResult(null)
              setLookupError(null)
            }}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            placeholder="1GKLRKEDXAJ275790  or  47ffb2b4ea3e585552da9a96597cdc1a"
            maxLength={64}
            spellCheck={false}
            className="w-full border border-border bg-transparent px-2.5 py-1.5 text-xs placeholder:text-muted-foreground/40 outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors font-mono tracking-wider"
          />

          {/* Env selector */}
          <div className="flex gap-1.5">
            {ENVS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setLookupEnv(e)}
                className={`px-2.5 py-1 text-[11px] border transition-colors uppercase tracking-wide ${
                  lookupEnv === e
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-muted-foreground"
                }`}
              >
                {e.replace("nsm-", "")}
              </button>
            ))}
          </div>

          {/* Lookup button */}
          <button
            onClick={handleLookup}
            disabled={!lookupInput.trim() || lookupLoading || lookupDirection === "unknown"}
            className="w-full border border-border text-xs py-1.5 text-muted-foreground hover:border-primary/60 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {lookupLoading ? "looking up…" : "lookup"}
          </button>

          {/* Error */}
          {lookupError && (
            <div className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 px-3 py-2">
              <span className="text-destructive text-xs shrink-0">✕</span>
              <span className="text-xs text-destructive">{lookupError}</span>
            </div>
          )}

          {/* Results */}
          {lookupResult && lookupResult.values.length === 0 && (
            <p className="text-xs text-muted-foreground/50 text-center py-1">
              {lookupResult.direction === "vin" ? "no application found" : "no VIN found"}
            </p>
          )}
          {lookupResult && lookupResult.values.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                {lookupResult.direction === "vin" ? "Application IDs" : "VINs"}
              </div>
              {lookupResult.values.map((value) => (
                <button
                  key={value}
                  onClick={() => copyId(value)}
                  className="w-full flex items-center justify-between px-3 py-2 border border-border hover:border-primary/50 hover:bg-primary/5 transition-all group"
                >
                  <span className="text-xs font-mono text-foreground tracking-wide">{value}</span>
                  <span className="text-[10px] text-muted-foreground/40 group-hover:text-primary transition-colors shrink-0 ml-3">
                    {copied === value ? "✓ copied" : "copy"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Hints */}
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/40">
            <Kbd>ctrl</Kbd>
            <span>+</span>
            <Kbd>k</Kbd>
            <span className="ml-0.5">search methods & pages</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/40">
            <Kbd>ctrl</Kbd>
            <span>+</span>
            <Kbd>v</Kbd>
            <span className="ml-0.5">anywhere opens an AD/PD item from a paste</span>
          </div>
        </div>
      </main>

      {/* Search modal */}
      <UnifiedSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* Toast */}
      {toast && (
        <div
          key={toast.key}
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 text-xs flex items-center gap-2 border shadow-lg animate-in slide-in-from-bottom-3 fade-in duration-150 ${
            toast.ok
              ? "bg-background border-primary/40 text-foreground"
              : "bg-background border-destructive/40 text-destructive"
          }`}
        >
          <span className={toast.ok ? "text-primary" : "text-destructive"}>{toast.ok ? "✓" : "✕"}</span>
          {toast.text}
        </div>
      )}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1.5 py-0.5 border border-border text-[10px] text-muted-foreground/50 leading-none">
      {children}
    </kbd>
  )
}
