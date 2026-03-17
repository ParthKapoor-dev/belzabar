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
    href: "/curl-to-ad",
    icon: "⌘",
    iconColor: "text-blue-400",
    hoverBorder: "hover:border-blue-500/50",
    hoverBg: "hover:bg-blue-500/5",
    label: "curl → AD",
    description: "Open AD method from curl command",
    hint: "ctrl+v",
  },
]

export default function Home() {
  const [toast, setToast] = useState<Toast | null>(null)
  const [toastTimer, setToastTimer] = useState<ReturnType<typeof setTimeout> | null>(null)

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
      <main className="flex-1 flex flex-col items-center justify-center px-6 gap-10">
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
