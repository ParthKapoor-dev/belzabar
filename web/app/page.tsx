"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"
import { parseCurl } from "@/lib/parse-curl"

type Toast = { text: string; ok: boolean; key: number }

const MODULES = [
  {
    href: "/ai",
    icon: "✦",
    iconColor: "text-primary",
    hoverBorder: "hover:border-primary/50",
    hoverBg: "hover:bg-primary/5",
    label: "AI Sessions",
    description: "Connect to coding agents via ACP",
    hint: "ctrl+a",
  },
  {
    href: "/curl",
    icon: "⌘",
    iconColor: "text-blue-400",
    hoverBorder: "hover:border-blue-500/50",
    hoverBg: "hover:bg-blue-500/5",
    label: "curl → AD",
    description: "Open AD method from curl command",
    hint: "ctrl+v",
  },
]

const ENVS = ["nsm-dev", "nsm-qa", "nsm-uat"] as const
type Env = (typeof ENVS)[number]

type VinResult = {
  ids: string[]
  rowCount: number
  env: string
  durationMs?: number
}

export default function Home() {
  const [toast, setToast] = useState<Toast | null>(null)
  const [toastTimer, setToastTimer] = useState<ReturnType<typeof setTimeout> | null>(null)

  // VIN lookup state
  const [vin, setVin] = useState("")
  const [vinEnv, setVinEnv] = useState<Env>("nsm-dev")
  const [vinLoading, setVinLoading] = useState(false)
  const [vinResult, setVinResult] = useState<VinResult | null>(null)
  const [vinError, setVinError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const showToast = useCallback((text: string, ok: boolean) => {
    if (toastTimer) clearTimeout(toastTimer)
    setToast({ text, ok, key: Date.now() })
    const t = setTimeout(() => setToast(null), 2800)
    setToastTimer(t)
  }, [toastTimer])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === "a") {
        const target = e.target as HTMLElement
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return
        e.preventDefault()
        window.location.href = "/ai"
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [])

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) return

      const text = e.clipboardData?.getData("text") ?? ""
      if (!text.trim()) return

      const { result, error } = parseCurl(text)
      if (result) {
        window.open(result.targetUrl, "_blank")
        showToast(`opened · ${result.uuid.slice(0, 8)}…`, true)
      } else if (error && (text.includes("curl") || text.includes("/execute/"))) {
        showToast(error, false)
      }
    }

    document.addEventListener("paste", handlePaste)
    return () => document.removeEventListener("paste", handlePaste)
  }, [showToast])

  const handleVinLookup = async () => {
    const trimmed = vin.trim()
    if (!trimmed) return
    setVinLoading(true)
    setVinResult(null)
    setVinError(null)
    try {
      const res = await fetch("/api/vin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vin: trimmed, env: vinEnv }),
      })
      const data = await res.json()
      if (!res.ok) {
        setVinError(data.error ?? "Lookup failed")
      } else {
        setVinResult(data as VinResult)
      }
    } catch {
      setVinError("Request failed")
    } finally {
      setVinLoading(false)
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-md">
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
        </div>

        {/* VIN Lookup */}
        <div className="w-full max-w-md border border-border p-5 space-y-4">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">VIN lookup</span>
            {vinResult && (
              <span className="text-[10px] text-muted-foreground/50">
                {vinResult.rowCount} result{vinResult.rowCount !== 1 ? "s" : ""} · {vinResult.durationMs}ms
              </span>
            )}
          </div>

          {/* VIN input */}
          <input
            type="text"
            value={vin}
            onChange={(e) => { setVin(e.target.value.toUpperCase()); setVinResult(null); setVinError(null) }}
            onKeyDown={(e) => e.key === "Enter" && handleVinLookup()}
            placeholder="1GKLRKEDXAJ275790"
            maxLength={17}
            spellCheck={false}
            className="w-full border border-border bg-transparent px-2.5 py-1.5 text-xs placeholder:text-muted-foreground/40 outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors uppercase tracking-wider"
          />

          {/* Env selector */}
          <div className="flex gap-1.5">
            {ENVS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setVinEnv(e)}
                className={`px-2.5 py-1 text-[11px] border transition-colors uppercase tracking-wide ${
                  vinEnv === e
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
            onClick={handleVinLookup}
            disabled={!vin.trim() || vinLoading}
            className="w-full border border-border text-xs py-1.5 text-muted-foreground hover:border-primary/60 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {vinLoading ? "looking up…" : "lookup"}
          </button>

          {/* Error */}
          {vinError && (
            <div className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 px-3 py-2">
              <span className="text-destructive text-xs shrink-0">✕</span>
              <span className="text-xs text-destructive">{vinError}</span>
            </div>
          )}

          {/* Results */}
          {vinResult && vinResult.ids.length === 0 && (
            <p className="text-xs text-muted-foreground/50 text-center py-1">no application found</p>
          )}
          {vinResult && vinResult.ids.length > 0 && (
            <div className="space-y-1.5">
              {vinResult.ids.map((id) => (
                <button
                  key={id}
                  onClick={() => copyId(id)}
                  className="w-full flex items-center justify-between px-3 py-2 border border-border hover:border-primary/50 hover:bg-primary/5 transition-all group"
                >
                  <span className="text-xs font-mono text-foreground tracking-wide">{id}</span>
                  <span className="text-[10px] text-muted-foreground/40 group-hover:text-primary transition-colors shrink-0 ml-3">
                    {copied === id ? "✓ copied" : "copy"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Paste hint */}
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/40">
          <Kbd>ctrl</Kbd>
          <span>+</span>
          <Kbd>v</Kbd>
          <span className="ml-0.5">anywhere opens AD method from curl</span>
        </div>
      </main>

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
