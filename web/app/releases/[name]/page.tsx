"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import type { MatrixData, ItemRow, Collision, Leak } from "@/lib/release-types"

// ── status / leak styling ────────────────────────────────────────────────────

function statusClass(status: string): string {
  switch (status) {
    case "latest": return "border-success/40 bg-success/10 text-success"
    case "behind": return "border-warning/40 bg-warning/10 text-warning"
    case "ahead-or-diverged": return "border-destructive/50 bg-destructive/10 text-destructive"
    case "missing": return "border-border bg-transparent text-muted-foreground/60"
    default: return "border-destructive/30 bg-transparent text-destructive/70" // error
  }
}

function leakClass(leak: Leak): string {
  if (leak === "leaked") return "border-destructive/50 bg-destructive/10 text-destructive"
  if (leak === "clean") return "border-success/40 bg-success/10 text-success"
  return "border-border bg-transparent text-muted-foreground"
}

// ── spine timeline ───────────────────────────────────────────────────────────
// One cell per spine position; environments sit under the position they point
// at, making "stage is behind dev" visible at a glance.

function SpineTimeline({ item }: { item: ItemRow }) {
  if (item.spineLen === 0) {
    return <div className="text-[11px] text-muted-foreground/50">no version history on the spine env</div>
  }
  const positions = Array.from({ length: item.spineLen }, (_, i) => i)
  const envsAt = (pos: number) => item.envs.filter((e) => e.spinePos === pos)

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {positions.map((pos) => {
          const here = envsAt(pos)
          const isHead = pos === item.spineLen - 1
          return (
            <div key={pos} className="flex flex-1 flex-col items-center gap-1">
              <div
                className={`h-2 w-full ${
                  here.length > 0
                    ? "bg-primary"
                    : isHead
                      ? "bg-muted-foreground/30"
                      : "bg-border"
                }`}
                title={`spine #${pos}`}
              />
              <div className="text-[9px] text-muted-foreground/40">#{pos}</div>
              <div className="flex flex-col items-center gap-0.5">
                {here.map((e) => (
                  <span
                    key={e.env}
                    className={`border px-1 py-px text-[9px] uppercase tracking-wide ${statusClass(e.status)}`}
                  >
                    {e.env.replace("nsm-", "")}
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {item.envs.some((e) => e.spinePos < 0) && (
        <div className="text-[10px] text-muted-foreground/50">
          off-spine:{" "}
          {item.envs
            .filter((e) => e.spinePos < 0)
            .map((e) => `${e.env} (${e.status})`)
            .join(", ")}
        </div>
      )}
    </div>
  )
}

// ── collision card ───────────────────────────────────────────────────────────

function CollisionCard({ c }: { c: Collision }) {
  return (
    <div className="border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-semibold tracking-tight">{c.name}</div>
          <div className="font-mono text-[10px] text-muted-foreground/60">{c.uuid}</div>
        </div>
        <span className={`shrink-0 border px-2 py-0.5 text-[10px] uppercase tracking-wide ${leakClass(c.leak)}`}>
          {c.leak}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
        <div>
          <span className="text-muted-foreground/50">included </span>
          {c.includedTickets.map((t) => (
            <span key={t} className="ml-1 text-success">#{t}</span>
          ))}
        </div>
        <div>
          <span className="text-muted-foreground/50">excluded </span>
          {c.excludedTickets.map((t) => (
            <span key={t} className="ml-1 text-destructive">#{t}</span>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{c.detail}</p>
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function ReleaseDetailPage() {
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(params.name)
  const [data, setData] = useState<MatrixData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch(`/api/releases/${encodeURIComponent(name)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Not found")
        return r.json()
      })
      .then((d) => setData(d as MatrixData))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
  }, [name])

  const toggle = (uuid: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(uuid) ? next.delete(uuid) : next.add(uuid)
      return next
    })

  const envNames = data ? [...new Set(data.items.flatMap((i) => i.envs.map((e) => e.env)))] : []

  return (
    <div className="min-h-screen bg-background text-foreground font-mono flex flex-col">
      <header className="border-b border-border px-6 h-11 flex items-center justify-between shrink-0">
        <Link href="/releases" className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 bg-primary" />
          <span className="text-sm font-semibold tracking-tight">belzabar</span>
          <span className="text-xs text-muted-foreground">/ releases</span>
        </Link>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
        {error && (
          <div className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {!data && !error && <p className="text-xs text-muted-foreground/50">loading…</p>}

        {data && (
          <>
            <div className="mb-8 space-y-1">
              <h1 className="text-2xl font-bold tracking-tighter">{data.name}</h1>
              <p className="text-xs text-muted-foreground">
                spine <span className="text-foreground">{data.spineEnv}</span> · stage{" "}
                <span className="text-foreground">{data.stageEnv}</span> ·{" "}
                {new Date(data.generatedAt).toLocaleString("en-US", {
                  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                })}
              </p>
            </div>

            {data.warnings.length > 0 && (
              <div className="mb-8 space-y-1 border border-warning/30 bg-warning/5 p-3">
                {data.warnings.map((w, i) => (
                  <div key={i} className="text-[11px] text-warning">⚠ {w}</div>
                ))}
              </div>
            )}

            {/* Collisions */}
            <section className="mb-10">
              <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Collisions ({data.collisions.length}) — AD items shared by an included & excluded ticket
              </h2>
              {data.collisions.length === 0 ? (
                <div className="border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">
                  No collisions — no AD item is shared between an included and an excluded ticket.
                </div>
              ) : (
                <div className="space-y-2">
                  {data.collisions.map((c) => (
                    <CollisionCard key={c.uuid} c={c} />
                  ))}
                </div>
              )}
            </section>

            {/* Item × env grid */}
            <section className="mb-10">
              <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                AD items ({data.items.length}) — click a row for its spine
              </h2>
              <div className="border border-border">
                <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <div className="flex-1">Item</div>
                  <div className="w-16">Kind</div>
                  {envNames.map((e) => (
                    <div key={e} className="w-20 text-center">{e.replace("nsm-", "")}</div>
                  ))}
                </div>
                {data.items.map((item) => (
                  <div key={item.uuid}>
                    <button
                      type="button"
                      onClick={() => toggle(item.uuid)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/20"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium">{item.name}</div>
                        <div className="font-mono text-[9px] text-muted-foreground/50">
                          {item.uuid.slice(0, 16)}…
                        </div>
                      </div>
                      <div className="w-16">
                        <span
                          className={`border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                            item.kind === "both"
                              ? "border-warning/50 bg-warning/10 text-warning"
                              : "border-border text-muted-foreground"
                          }`}
                        >
                          {item.kind}
                        </span>
                      </div>
                      {envNames.map((en) => {
                        const cell = item.envs.find((e) => e.env === en)
                        return (
                          <div key={en} className="w-20 text-center">
                            {cell ? (
                              <span
                                className={`border px-1 py-0.5 text-[9px] uppercase tracking-wide ${statusClass(cell.status)}`}
                                title={cell.spinePos >= 0 ? `spine #${cell.spinePos} (v${cell.spineVersion})` : cell.status}
                              >
                                {cell.status === "latest" ? "latest"
                                  : cell.status === "behind" ? `#${cell.spinePos}`
                                  : cell.status === "ahead-or-diverged" ? "diverged"
                                  : cell.status}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/30">—</span>
                            )}
                          </div>
                        )
                      })}
                    </button>
                    {expanded.has(item.uuid) && (
                      <div className="border-t border-border bg-muted/10 px-4 py-3">
                        {item.error ? (
                          <div className="text-[11px] text-destructive">trace error: {item.error}</div>
                        ) : (
                          <SpineTimeline item={item} />
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {data.items.length === 0 && (
                  <div className="px-3 py-3 text-[11px] text-muted-foreground/50">No AD items.</div>
                )}
              </div>
            </section>

            {/* Tickets */}
            <section className="mb-10">
              <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Tickets ({data.tickets.length})
              </h2>
              <div className="space-y-1">
                {data.tickets.map((t) => (
                  <div
                    key={`${t.id}-${t.kind}`}
                    className="flex items-center gap-3 border border-border px-3 py-2"
                  >
                    <span
                      className={`border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                        t.kind === "included"
                          ? "border-success/40 bg-success/10 text-success"
                          : "border-destructive/40 bg-destructive/10 text-destructive"
                      }`}
                    >
                      {t.kind}
                    </span>
                    <a
                      href={`https://projects.webintensive.com/app/tasks/${t.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      #{t.id}
                    </a>
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {t.error ? <span className="text-destructive">error: {t.error}</span> : t.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/50">
                      {t.ad.length} AD · {t.pd.length} PD
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <p className="text-[11px] text-muted-foreground/50">{data.pdNote}</p>
          </>
        )}
      </main>
    </div>
  )
}
