"use client"

import { useState, useCallback } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { parseCurl, type ParseResult } from "@/lib/parse-curl"

function sortedEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
}

function ValuePill({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted-foreground italic">null</span>
  if (typeof value === "boolean") return <span className="text-primary">{String(value)}</span>
  if (typeof value === "number") return <span className="text-yellow-500 dark:text-yellow-400">{String(value)}</span>
  if (typeof value === "string") return <span className="text-green-600 dark:text-green-400">&quot;{value}&quot;</span>
  return <span className="text-foreground">{JSON.stringify(value)}</span>
}

export default function CurlPage() {
  const [raw, setRaw] = useState("")
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)

  const handleChange = useCallback((val: string) => {
    setRaw(val)
    setOpened(false)
    const { result, error: err } = parseCurl(val)
    setParsed(result)
    setError(err)
  }, [])

  const handleOpen = () => {
    if (!parsed) return
    window.open(parsed.targetUrl, "_blank")
    setOpened(true)
    setTimeout(() => setOpened(false), 2000)
  }

  const inputCount = parsed ? Object.keys(parsed.body).length : 0
  const nonNullCount = parsed ? Object.values(parsed.body).filter(v => v !== null).length : 0

  return (
    <div className="min-h-screen bg-background text-foreground font-mono flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-6 h-11 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <div className="w-1.5 h-1.5 bg-primary" />
            <span className="text-sm font-semibold tracking-tight">belzabar</span>
          </Link>
          <span className="text-muted-foreground/40 text-xs">/</span>
          <span className="text-xs text-muted-foreground">curl → AD</span>
        </div>
        <span className="text-[10px] text-muted-foreground/50 uppercase tracking-widest hidden sm:block">
          paste a curl · open with inputs pre-filled
        </span>
      </header>

      <div className="flex-1 max-w-6xl w-full mx-auto px-6 py-8 flex flex-col gap-6">
        {/* Title */}
        <div className="space-y-1">
          <h1 className="text-sm font-medium">curl → AD autofill</h1>
          <p className="text-xs text-muted-foreground">
            Paste a{" "}
            <code className="bg-muted px-1.5 py-0.5 text-foreground/80">/rest/api/automation/chain/execute/…</code>{" "}
            curl command. UUID and JSON body are extracted and the AD page opens with inputs pre-filled.
          </p>
        </div>

        {/* Main layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1">

          {/* Left: input */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                Curl command
              </label>
              {raw && (
                <button
                  onClick={() => handleChange("")}
                  className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  clear
                </button>
              )}
            </div>

            <textarea
              value={raw}
              onChange={(e) => handleChange(e.target.value)}
              onPaste={(e) => {
                setTimeout(() => handleChange((e.target as HTMLTextAreaElement).value), 0)
              }}
              placeholder={"curl 'https://nsm-dev.nc.verifi.dev/rest/api/automation/chain/execute/…' \\\n  -X POST \\\n  -H 'Authorization: Bearer …' \\\n  --data-raw '{\"key\":\"value\"}'"}
              className="flex-1 min-h-[280px] resize-y w-full border border-border bg-transparent text-xs leading-relaxed placeholder:text-muted-foreground/40 p-3 outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 transition-colors font-mono"
              spellCheck={false}
              autoComplete="off"
            />

            {error && (
              <div className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 px-3 py-2.5">
                <span className="text-destructive shrink-0 text-xs mt-px">✕</span>
                <span className="text-xs text-destructive">{error}</span>
              </div>
            )}

            <Button
              onClick={handleOpen}
              disabled={!parsed}
              size="sm"
              className="w-full"
            >
              {opened ? "✓ opened" : parsed ? "open AD page →" : "open AD page"}
            </Button>
          </div>

          {/* Right: preview */}
          <div className="flex flex-col gap-3">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
              Preview
            </label>

            {!parsed && !error && !raw && (
              <div className="flex-1 border border-border flex flex-col items-center justify-center min-h-[280px] gap-3">
                <span className="text-2xl text-muted-foreground/30">⌘</span>
                <p className="text-xs text-muted-foreground/50 text-center max-w-[180px] leading-relaxed">
                  paste a curl command to see the parsed result
                </p>
              </div>
            )}

            {!parsed && (error || raw) && (
              <div className="flex-1 border border-border flex flex-col items-center justify-center min-h-[280px]">
                <p className="text-xs text-muted-foreground/40">nothing to preview</p>
              </div>
            )}

            {parsed && (
              <div className="flex flex-col gap-3">
                {/* Meta row */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="border border-border px-3 py-2.5">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 font-semibold">host</div>
                    <div className="text-xs text-primary truncate">{parsed.host}</div>
                  </div>
                  <div className="border border-border px-3 py-2.5">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1 font-semibold">uuid</div>
                    <div className="text-xs text-muted-foreground truncate font-mono" title={parsed.uuid}>{parsed.uuid.slice(0, 16)}…</div>
                  </div>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span><span className="text-foreground font-medium">{inputCount}</span> fields</span>
                  <span className="text-border">·</span>
                  <span><span className="text-primary font-medium">{nonNullCount}</span> non-null</span>
                  <span className="text-border">·</span>
                  <span><span className="text-muted-foreground font-medium">{inputCount - nonNullCount}</span> null</span>
                </div>

                {/* JSON preview */}
                <div className="border border-border overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">request body</span>
                    <span className="text-[10px] text-muted-foreground/40">json</span>
                  </div>
                  <div className="overflow-y-auto max-h-[260px] p-3 text-xs leading-relaxed">
                    <table className="w-full border-collapse">
                      <tbody>
                        {sortedEntries(parsed.body).map(([k, v]) => (
                          <tr key={k} className="group">
                            <td className="pr-4 py-0.5 text-muted-foreground group-hover:text-foreground transition-colors whitespace-nowrap align-top w-1/2">
                              {k}
                            </td>
                            <td className="py-0.5 align-top">
                              <ValuePill value={v} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Target URL */}
                <div className="border border-border overflow-hidden">
                  <div className="px-3 py-2 border-b border-border">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">target url</span>
                  </div>
                  <div className="px-3 py-2.5">
                    <p className="text-[11px] text-muted-foreground break-all leading-relaxed">
                      <span className="text-foreground/70">https://{parsed.host}/automation-designer/NSM.Staff/</span>
                      <span className="text-primary">{parsed.uuid}</span>
                      <span className="text-muted-foreground/50">?_belz_autofill=…</span>
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
