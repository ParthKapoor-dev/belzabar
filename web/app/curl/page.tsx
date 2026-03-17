"use client"

import { useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { parseCurl, type ParseResult } from "@/lib/parse-curl"

function sortedEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
}

function ValuePill({ value }: { value: unknown }) {
  if (value === null) return <span className="text-zinc-600 italic">null</span>
  if (typeof value === "boolean") return <span className="text-violet-400">{String(value)}</span>
  if (typeof value === "number") return <span className="text-amber-400">{String(value)}</span>
  if (typeof value === "string") return <span className="text-emerald-400">&quot;{value}&quot;</span>
  return <span className="text-zinc-300">{JSON.stringify(value)}</span>
}

export default function CurlToAdPage() {
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-mono">
      {/* Top bar */}
      <div className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_2px_rgba(59,130,246,0.5)]" />
            <span className="text-sm font-semibold tracking-tight text-zinc-100">curl → AD Autofill</span>
            <span className="text-zinc-600 text-xs hidden sm:block">/ belzabar devtools</span>
          </div>
          <div className="text-xs text-zinc-600">
            Paste a curl · Open with inputs pre-filled
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* Title */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50 mb-1">
            Open AD page from curl
          </h1>
          <p className="text-sm text-zinc-500">
            Paste a <code className="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs">/rest/api/automation/chain/execute/…</code> curl command.
            The UUID and JSON body are extracted and the AD page opens with inputs pre-filled by the extension.
          </p>
        </div>

        {/* Main layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* Left: input */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
                Curl command
              </label>
              {raw && (
                <button
                  onClick={() => handleChange("")}
                  className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  clear
                </button>
              )}
            </div>
            <textarea
              value={raw}
              onChange={(e: { target: { value: string } }) => handleChange(e.target.value)}
              onPaste={(e: { target: unknown }) => {
                setTimeout(() => handleChange((e.target as HTMLTextAreaElement).value), 0)
              }}
              placeholder={"curl 'https://nsm-dev.nc.verifi.dev/rest/api/automation/chain/execute/…'\\\n  -X POST \\\n  -H 'Authorization: Bearer …' \\\n  --data-raw '{\"key\":\"value\"}'"}
              className="
                w-full min-h-[320px] resize-y rounded-lg border border-zinc-800
                bg-zinc-900 text-zinc-200 text-xs leading-relaxed
                placeholder:text-zinc-700 p-4
                focus:outline-none focus:border-blue-600/70 focus:ring-1 focus:ring-blue-600/30
                transition-colors font-mono
              "
              spellCheck={false}
              autoComplete="off"
            />

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 rounded-md bg-red-950/40 border border-red-800/50 px-3 py-2.5">
                <span className="text-red-500 mt-0.5 shrink-0">✕</span>
                <span className="text-xs text-red-400">{error}</span>
              </div>
            )}

            {/* Open button */}
            <Button
              onClick={handleOpen}
              disabled={!parsed}
              className="
                w-full h-10 text-sm font-semibold tracking-tight
                bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800
                disabled:text-zinc-600 text-white
                border-0 rounded-lg transition-all duration-150
                disabled:cursor-not-allowed
              "
            >
              {opened
                ? "✓ Opened"
                : parsed
                ? `Open AD Page →`
                : "Open AD Page"}
            </Button>
          </div>

          {/* Right: preview */}
          <div className="flex flex-col gap-3">
            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-widest">
              Preview
            </label>

            {!parsed && !error && !raw && (
              <div className="flex-1 rounded-lg border border-zinc-800/60 bg-zinc-900/40 flex flex-col items-center justify-center min-h-[320px] gap-3">
                <div className="w-10 h-10 rounded-full border border-zinc-800 flex items-center justify-center text-xl">
                  ⌘
                </div>
                <p className="text-xs text-zinc-600 text-center max-w-[200px] leading-relaxed">
                  Paste a curl command on the left to see the parsed result here
                </p>
              </div>
            )}

            {!parsed && (error || raw) && (
              <div className="flex-1 rounded-lg border border-zinc-800/60 bg-zinc-900/40 flex flex-col items-center justify-center min-h-[320px] gap-2">
                <p className="text-xs text-zinc-600">Nothing to preview</p>
              </div>
            )}

            {parsed && (
              <div className="flex flex-col gap-3">
                {/* Meta row */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                    <div className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1.5 font-semibold">Host</div>
                    <div className="text-xs text-blue-400 truncate">{parsed.host}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                    <div className="text-[10px] text-zinc-600 uppercase tracking-widest mb-1.5 font-semibold">UUID</div>
                    <div className="text-xs text-amber-400 truncate" title={parsed.uuid}>{parsed.uuid.slice(0, 16)}…</div>
                  </div>
                </div>

                {/* Stats */}
                <div className="flex items-center gap-4 px-1">
                  <span className="text-xs text-zinc-500">
                    <span className="text-zinc-300 font-semibold">{inputCount}</span> fields
                  </span>
                  <span className="text-zinc-700">·</span>
                  <span className="text-xs text-zinc-500">
                    <span className="text-emerald-400 font-semibold">{nonNullCount}</span> non-null
                  </span>
                  <span className="text-zinc-700">·</span>
                  <span className="text-xs text-zinc-500">
                    <span className="text-zinc-400 font-semibold">{inputCount - nonNullCount}</span> null
                  </span>
                </div>

                {/* JSON preview */}
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/80">
                    <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Request Body</span>
                    <span className="text-[10px] text-zinc-700">JSON</span>
                  </div>
                  <div className="overflow-y-auto max-h-[300px] p-4 text-xs leading-relaxed">
                    <table className="w-full border-collapse">
                      <tbody>
                        {sortedEntries(parsed.body).map(([k, v]) => (
                          <tr key={k} className="group">
                            <td className="pr-4 py-0.5 text-zinc-500 group-hover:text-zinc-300 transition-colors whitespace-nowrap align-top w-1/2">
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
                <div className="rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800">
                    <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Target URL</span>
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-[11px] text-zinc-500 break-all leading-relaxed">
                      <span className="text-zinc-300">https://{parsed.host}/automation-designer/NSM.Staff/</span>
                      <span className="text-amber-400">{parsed.uuid}</span>
                      <span className="text-zinc-600">?_belz_autofill=</span>
                      <span className="text-zinc-700">…</span>
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
