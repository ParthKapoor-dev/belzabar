"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"

// The AD Network DevTools panel POSTs "open in draft" requests to
// /api/open-queue. This page polls that inbox and opens each method's draft
// designer URL — with inputs autofilled — one at a time.

type Status = "queued" | "resolving" | "opening" | "opened" | "failed"

interface Job {
  id: number
  uuid: string
  env: string
  body: string
  status: Status
  name?: string
  error?: string
}

const JOBS_KEY = "belzQueueJobs"
const LASTID_KEY = "belzQueueLastId"
const POLL_MS = 1000

function loadJobs(): Job[] {
  try {
    const raw = localStorage.getItem(JOBS_KEY)
    if (!raw) return []
    const jobs = JSON.parse(raw) as Job[]
    // A reload may have interrupted an in-flight job — re-queue it.
    return jobs.map((j) =>
      j.status === "resolving" || j.status === "opening"
        ? { ...j, status: "queued" }
        : j,
    )
  } catch {
    return []
  }
}

function loadLastId(): number {
  const n = Number.parseInt(localStorage.getItem(LASTID_KEY) ?? "0", 10)
  return Number.isFinite(n) ? n : 0
}

function autofillUrl(editUrl: string, body: string): string {
  if (!body.trim()) return editUrl
  let encoded: string
  try {
    encoded = btoa(body)
  } catch {
    return editUrl // body has non-Latin1 chars — open without autofill
  }
  const sep = editUrl.includes("?") ? "&" : "?"
  return `${editUrl}${sep}_belz_autofill=${encodeURIComponent(encoded)}`
}

const STATUS_LABEL: Record<Status, string> = {
  queued: "queued",
  resolving: "resolving draft id…",
  opening: "opening",
  opened: "opened",
  failed: "failed",
}

function Spinner() {
  return (
    <span className="inline-flex gap-0.5 items-center">
      <span className="size-1 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.3s]" />
      <span className="size-1 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.15s]" />
      <span className="size-1 rounded-full bg-primary/60 animate-bounce" />
    </span>
  )
}

function StatusCell({ job }: { job: Job }) {
  const active = job.status === "resolving" || job.status === "opening"
  const color =
    job.status === "opened"
      ? "text-green-600 dark:text-green-400"
      : job.status === "failed"
        ? "text-destructive"
        : active
          ? "text-primary"
          : "text-muted-foreground"
  return (
    <span className={`flex items-center gap-1.5 text-xs ${color}`}>
      {active && <Spinner />}
      {job.status === "failed" && job.error ? job.error : STATUS_LABEL[job.status]}
    </span>
  )
}

export default function QueuePage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null)

  // Refs mirror state so the async pump always sees the latest values.
  const jobsRef = useRef<Job[]>([])
  const lastIdRef = useRef(0)
  const processingRef = useRef(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ text, key: Date.now() })
    toastTimer.current = setTimeout(() => setToast(null), 2800)
  }, [])

  // Commit a new jobs array to state, ref and localStorage in one place.
  const commitJobs = useCallback((next: Job[]) => {
    jobsRef.current = next
    setJobs(next)
    try {
      localStorage.setItem(JOBS_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }, [])

  const patchJob = useCallback(
    (id: number, patch: Partial<Job>) => {
      commitJobs(
        jobsRef.current.map((j) => (j.id === id ? { ...j, ...patch } : j)),
      )
    },
    [commitJobs],
  )

  // Process queued jobs strictly one at a time.
  const pump = useCallback(async () => {
    if (processingRef.current) return
    const job = jobsRef.current.find((j) => j.status === "queued")
    if (!job) return
    processingRef.current = true

    patchJob(job.id, { status: "resolving" })
    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: job.uuid, env: job.env }),
      })
      const data = await res.json()
      if (!res.ok || !data.resolved || typeof data.editUrl !== "string") {
        throw new Error(data.reason || data.error || "could not resolve draft")
      }
      const name: string = data.name || job.uuid.slice(0, 8) + "…"
      patchJob(job.id, { status: "opening", name })
      window.open(autofillUrl(data.editUrl, job.body), "_blank")
      showToast(`opening ${name} in draft mode`)
      patchJob(job.id, { status: "opened", name })
    } catch (err) {
      patchJob(job.id, {
        status: "failed",
        error: err instanceof Error ? err.message : "failed",
      })
    } finally {
      processingRef.current = false
      // Chain to the next queued job, if any.
      if (jobsRef.current.some((j) => j.status === "queued")) {
        setTimeout(pump, 150)
      }
    }
  }, [patchJob, showToast])

  // Mount: restore persisted state, then poll the server inbox.
  useEffect(() => {
    const restored = loadJobs()
    jobsRef.current = restored
    setJobs(restored)
    lastIdRef.current = loadLastId()

    let alive = true
    async function poll() {
      try {
        const res = await fetch("/api/open-queue", { cache: "no-store" })
        if (!res.ok) return
        const data = await res.json()
        const items: Array<{ id: number; uuid: string; env: string; body: string }> =
          Array.isArray(data.items) ? data.items : []
        const fresh = items.filter((it) => it.id > lastIdRef.current)
        if (fresh.length > 0) {
          lastIdRef.current = Math.max(...fresh.map((it) => it.id))
          try {
            localStorage.setItem(LASTID_KEY, String(lastIdRef.current))
          } catch {
            /* ignore */
          }
          const added: Job[] = fresh.map((it) => ({
            id: it.id,
            uuid: it.uuid,
            env: it.env,
            body: it.body,
            status: "queued",
          }))
          commitJobs([...jobsRef.current, ...added])
        }
      } catch {
        /* belz web inbox unreachable — ignore, retry next tick */
      }
      if (alive) pump()
    }

    poll()
    const timer = setInterval(poll, POLL_MS)
    // Resume any job re-queued from a previous (interrupted) session.
    pump()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [commitJobs, pump])

  const clearFinished = useCallback(() => {
    commitJobs(
      jobsRef.current.filter(
        (j) => j.status !== "opened" && j.status !== "failed",
      ),
    )
  }, [commitJobs])

  const pending = jobs.filter(
    (j) => j.status === "queued" || j.status === "resolving" || j.status === "opening",
  ).length

  return (
    <div className="min-h-screen bg-background text-foreground font-mono flex flex-col">
      <header className="border-b border-border px-6 h-11 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <div className="w-1.5 h-1.5 bg-primary" />
            <span className="text-sm font-semibold tracking-tight">belzabar</span>
          </Link>
          <span className="text-muted-foreground/40 text-xs">/</span>
          <span className="text-xs text-muted-foreground">open queue</span>
        </div>
        <span className="text-[10px] text-muted-foreground/50 uppercase tracking-widest hidden sm:block">
          AD methods · opened in draft mode
        </span>
      </header>

      <div className="flex-1 max-w-4xl w-full mx-auto px-6 py-8 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-sm font-medium">Open queue</h1>
            <p className="text-xs text-muted-foreground">
              Requests sent from the AD Network panel. Each method&apos;s draft
              page opens with inputs autofilled, one at a time.
            </p>
          </div>
          {jobs.some((j) => j.status === "opened" || j.status === "failed") && (
            <button
              onClick={clearFinished}
              className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors shrink-0"
            >
              clear finished
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            <span className="text-foreground font-medium">{jobs.length}</span> total
          </span>
          <span className="text-border">·</span>
          <span>
            <span className="text-primary font-medium">{pending}</span> pending
          </span>
        </div>

        {jobs.length === 0 ? (
          <div className="flex-1 border border-border flex flex-col items-center justify-center min-h-[260px] gap-3">
            <span className="text-2xl text-muted-foreground/30">↗</span>
            <p className="text-xs text-muted-foreground/50 text-center max-w-[220px] leading-relaxed">
              Waiting for requests. Click <span className="text-foreground/70">Open</span>{" "}
              on a row in the AD Network DevTools panel.
            </p>
          </div>
        ) : (
          <div className="border border-border overflow-hidden">
            {jobs
              .slice()
              .reverse()
              .map((job) => (
                <div
                  key={job.id}
                  className="flex items-center gap-3 px-3 py-2.5 border-b border-border last:border-b-0"
                >
                  <span className="text-[10px] text-muted-foreground/40 tabular-nums w-6 shrink-0">
                    {job.id}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-xs">
                    {job.name ? (
                      <span className="text-foreground">{job.name}</span>
                    ) : (
                      <span className="text-muted-foreground font-mono">
                        {job.uuid.slice(0, 16)}…
                      </span>
                    )}
                    <span className="text-muted-foreground/40 ml-2">{job.env}</span>
                  </span>
                  <StatusCell job={job} />
                </div>
              ))}
          </div>
        )}
      </div>

      {toast && (
        <div
          key={toast.key}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 text-xs flex items-center gap-2 border shadow-lg bg-background border-primary/40 text-foreground animate-in slide-in-from-bottom-3 fade-in duration-150"
        >
          <span className="text-primary">↗</span>
          {toast.text}
        </div>
      )}
    </div>
  )
}
