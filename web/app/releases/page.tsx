"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import type { ReleaseSummary } from "@/lib/release-types"

export default function ReleasesPage() {
  const [releases, setReleases] = useState<ReleaseSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/releases")
      .then((r) => r.json())
      .then((d) => setReleases(d.releases ?? []))
      .catch(() => setError("Could not load releases"))
  }, [])

  return (
    <div className="min-h-screen bg-background text-foreground font-mono flex flex-col">
      <header className="border-b border-border px-6 h-11 flex items-center justify-between shrink-0">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 bg-primary" />
          <span className="text-sm font-semibold tracking-tight">belzabar</span>
        </Link>
        <span className="hidden text-[10px] uppercase tracking-widest text-muted-foreground sm:block">
          release audits
        </span>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <div className="mb-8 space-y-1">
          <h1 className="text-2xl font-bold tracking-tighter">Releases</h1>
          <p className="text-xs text-muted-foreground">
            Promotion audits from <span className="text-foreground">belz release matrix</span>. Each
            shows which AD items collide between included and excluded tickets.
          </p>
        </div>

        {error && (
          <div className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {releases === null && !error && (
          <p className="text-xs text-muted-foreground/50">loading…</p>
        )}

        {releases !== null && releases.length === 0 && (
          <div className="border border-border p-6 text-center">
            <p className="text-xs text-muted-foreground">No release audits yet.</p>
            <p className="mt-1 text-[11px] text-muted-foreground/50">
              Run <span className="text-foreground">belz release matrix &lt;release.json&gt;</span> to create one.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {releases?.map((r) => (
            <Link
              key={r.name}
              href={`/releases/${encodeURIComponent(r.name)}`}
              className="group flex items-center justify-between border border-border p-4 transition-all duration-100 hover:border-primary/50 hover:bg-primary/5"
            >
              <div className="space-y-1">
                <div className="text-sm font-semibold tracking-tight">{r.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {r.ticketCount} ticket{r.ticketCount !== 1 ? "s" : ""} · {r.itemCount} AD item
                  {r.itemCount !== 1 ? "s" : ""} ·{" "}
                  {new Date(r.generatedAt).toLocaleString("en-US", {
                    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                  })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {r.leakedCount > 0 && (
                  <span className="border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-destructive">
                    {r.leakedCount} leaked
                  </span>
                )}
                <span
                  className={`border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                    r.collisionCount > 0
                      ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                      : "border-emerald-500/40 bg-emerald-500/5 text-emerald-400"
                  }`}
                >
                  {r.collisionCount} collision{r.collisionCount !== 1 ? "s" : ""}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  )
}
