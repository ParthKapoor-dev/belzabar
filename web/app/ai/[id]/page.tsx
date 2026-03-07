"use client"

import { use, useRef, useEffect, useState, type KeyboardEvent } from "react"
import { useRouter } from "next/navigation"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { CornersOut, CornersIn } from "@phosphor-icons/react"
import { useSessionsContext } from "@/lib/sessions-context"
import type { AssistantMessage, Message, PendingPermission, ToolCallState } from "@/hooks/use-sessions"

// ─── helpers ──────────────────────────────────────────────────────────────────

function summarizeInput(raw: unknown, max = 140): string {
  if (raw == null) return ""
  if (typeof raw === "string") return raw.trim().slice(0, max)
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    const val = r.command ?? r.path ?? r.filePath ?? r.query ?? r.pattern ?? r.text
    if (typeof val === "string") return val.trim().slice(0, max)
  }
  try {
    return JSON.stringify(raw).slice(0, max)
  } catch {
    return ""
  }
}

function extractOutput(rawOutput: unknown, content: unknown): string {
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content as Array<Record<string, unknown>>) {
      const c = item.content as Record<string, unknown> | undefined
      if (item.type === "content" && c?.type === "text" && typeof c.text === "string") {
        parts.push(c.text)
      } else if (item.type === "diff" && typeof item.path === "string") {
        const oldLines = typeof item.oldText === "string" ? item.oldText.split("\n").length : 0
        const newLines = typeof item.newText === "string" ? item.newText.split("\n").length : 0
        const delta = newLines - oldLines
        parts.push(`diff ${item.path} (${delta >= 0 ? "+" : ""}${delta} lines)`)
      }
    }
    if (parts.length > 0) return parts.join("\n")
  }
  if (rawOutput == null) return ""
  if (typeof rawOutput === "string") return rawOutput.trim()
  const r = rawOutput as Record<string, unknown>
  const str = r.stdout ?? r.stderr ?? r.output ?? r.content ?? r.text ?? r.result
  if (typeof str === "string") return str.trim()
  try {
    return JSON.stringify(rawOutput, null, 2)
  } catch {
    return ""
  }
}

const STATUS_COLOR: Record<string, string> = {
  running: "text-yellow-500 dark:text-yellow-400",
  in_progress: "text-yellow-500 dark:text-yellow-400",
  pending: "text-muted-foreground",
  completed: "text-green-600 dark:text-green-400",
  failed: "text-destructive",
}

// ─── ToolCallCard ─────────────────────────────────────────────────────────────

function ToolCallCard({ tc }: { tc: ToolCallState }) {
  const [open, setOpen] = useState(false)
  const input = summarizeInput(tc.rawInput)
  const isFinal = tc.status === "completed" || tc.status === "failed"
  const output = isFinal ? extractOutput(tc.rawOutput, tc.content) : ""
  const statusColor = STATUS_COLOR[tc.status] ?? "text-muted-foreground"

  return (
    <div className="border-l-2 border-border pl-3 space-y-0.5 py-0.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-muted-foreground select-none">[tool]</span>
        <span className="font-medium truncate">{tc.title || tc.toolCallId}</span>
        {tc.kind && <span className="text-muted-foreground shrink-0">· {tc.kind}</span>}
        <span className={cn("ml-auto shrink-0 tabular-nums", statusColor)}>{tc.status}</span>
      </div>

      {input && (
        <p className="text-xs text-muted-foreground pl-10 truncate">
          <span className="select-none">in: </span>
          {input}
        </p>
      )}

      {isFinal && output && (
        <div className="pl-10 text-xs">
          <button
            onClick={() => setOpen((x) => !x)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="select-none">{open ? "▾" : "▸"} </span>output
          </button>
          {open && (
            <pre className="mt-1 p-2 bg-muted/40 text-foreground overflow-x-auto max-h-52 whitespace-pre-wrap text-xs leading-relaxed">
              {output.length > 3000 ? output.slice(0, 3000) + "\n…" : output}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ─── MessageItem ──────────────────────────────────────────────────────────────

function MessageItem({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex gap-2.5 text-sm">
        <span className="text-primary shrink-0 select-none mt-0.5">▸</span>
        <span className="whitespace-pre-wrap break-words">{message.text}</span>
      </div>
    )
  }

  const m = message as AssistantMessage
  const hasContent =
    m.thinking || m.toolCalls.length > 0 || m.plan || m.text || m.stopReason || m.error

  if (!hasContent) {
    return <div className="text-xs text-muted-foreground animate-pulse pl-5">···</div>
  }

  return (
    <div className="space-y-2 pl-5">
      {m.thinking && (
        <p className="text-xs text-muted-foreground italic leading-relaxed">
          ··· {m.thinking.trim().slice(0, 400)}
          {m.thinking.length > 400 ? "…" : ""}
        </p>
      )}

      {m.plan && m.plan.length > 0 && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          <span className="select-none">[plan]</span>
          {m.plan.map((e, i) => (
            <div key={i} className="flex gap-1.5 pl-4">
              <span
                className={cn(
                  e.status === "done" || e.status === "completed"
                    ? "text-green-600 dark:text-green-400"
                    : "",
                )}
              >
                {e.status === "done" || e.status === "completed" ? "●" : "○"}
              </span>
              <span>{e.content}</span>
            </div>
          ))}
        </div>
      )}

      {m.toolCalls.map((tc) => (
        <ToolCallCard key={tc.toolCallId} tc={tc} />
      ))}

      {m.text && (
        <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{m.text}</p>
      )}

      {m.stopReason && (
        <p className="text-xs text-muted-foreground select-none">[done] {m.stopReason}</p>
      )}

      {m.error && <p className="text-xs text-destructive">[error] {m.error}</p>}
    </div>
  )
}

// ─── PermissionCard ───────────────────────────────────────────────────────────

function PermissionCard({
  id,
  permission,
  onResolve,
}: {
  id: string
  permission: PendingPermission
  onResolve: (id: string, optionId: string | null) => void
}) {
  const allowOpts = permission.options.filter((o) => o.kind.startsWith("allow"))
  const rejectOpts = permission.options.filter((o) => !o.kind.startsWith("allow"))

  return (
    <div className="mx-3 mb-2 border border-border bg-muted/20 p-3 text-xs space-y-2">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span className="select-none">permission</span>
        {permission.toolCall.kind && <span>· {permission.toolCall.kind}</span>}
      </div>
      <p className="font-medium">{permission.toolCall.title}</p>
      <div className="flex flex-wrap gap-2 pt-0.5">
        {allowOpts.map((o) => (
          <Button key={o.optionId} size="xs" onClick={() => onResolve(id, o.optionId)}>
            {o.name}
          </Button>
        ))}
        {rejectOpts.map((o) => (
          <Button key={o.optionId} size="xs" variant="outline" onClick={() => onResolve(id, o.optionId)}>
            {o.name}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={() => onResolve(id, null)}>
          cancel
        </Button>
      </div>
    </div>
  )
}

// ─── SessionPage ──────────────────────────────────────────────────────────────

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { slots, sendPrompt, cancelPrompt, resolvePermission, removeSession } = useSessionsContext()

  const slot = slots.find((s) => s.id === id) ?? null

  const [input, setInput] = useState("")
  const [inputFocused, setInputFocused] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const messages = slot?.messages ?? []
  const isRunning = slot?.isRunning ?? false
  const isDisconnected = slot?.connectionStatus === "disconnected"
  const pendingPermission = slot?.pendingPermission ?? null

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (!input.trim()) return
      void sendPrompt(id, input)
      setInput("")
    }
  }

  const handleSend = () => {
    if (!input.trim()) return
    void sendPrompt(id, input)
    setInput("")
  }

  const handleRemove = async () => {
    await removeSession(id)
    const remaining = slots.filter((s) => s.id !== id)
    router.push(remaining.length > 0 ? `/ai/${remaining[0].id}` : "/ai")
  }

  if (!slot) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-muted-foreground">
          session not found.{" "}
          <button onClick={() => router.push("/ai")} className="underline hover:text-foreground">
            start a new one
          </button>
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <span className="font-medium truncate min-w-0">{slot.cwd}</span>
        <span
          className={cn(
            "size-1.5 rounded-full shrink-0",
            isRunning
              ? "bg-yellow-500 animate-pulse"
              : isDisconnected
                ? "bg-muted-foreground/50"
                : "bg-green-500 dark:bg-green-400",
          )}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleRemove}
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
          title="close session"
        >
          ✕
        </Button>
      </header>

      {/* disconnected banner */}
      {isDisconnected && (
        <div className="shrink-0 px-4 py-1.5 bg-muted/30 border-b border-border text-xs text-muted-foreground">
          history only — agent session no longer exists
        </div>
      )}

      {/* messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-5 space-y-6 max-w-3xl mx-auto">
          {messages.length === 0 && (
            <p className="text-xs text-muted-foreground">session ready — send a prompt.</p>
          )}
          {messages.map((msg, i) => (
            <MessageItem key={i} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* permission overlay */}
      {pendingPermission && (
        <PermissionCard id={id} permission={pendingPermission} onResolve={resolvePermission} />
      )}

      {/* input */}
      <div className="shrink-0 border-t border-border p-4">
        <div className="relative max-w-3xl mx-auto rounded-lg border border-border bg-background transition-shadow focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            disabled={isRunning || isDisconnected}
            placeholder={
              isDisconnected
                ? "session disconnected"
                : isRunning
                  ? "agent is running…"
                  : "message opencode…"
            }
            autoFocus={!isDisconnected}
            className={cn(
              "w-full resize-none bg-transparent px-4 pt-4 pb-11 text-sm leading-relaxed placeholder:text-muted-foreground/70 outline-none disabled:opacity-40 disabled:cursor-not-allowed",
              expanded ? "min-h-[320px] max-h-[320px]" : "min-h-[80px] max-h-[260px]",
            )}
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />
          <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between pointer-events-none">
            <div className="pointer-events-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setExpanded((x) => !x)}
                title={expanded ? "collapse" : "expand"}
                className="text-muted-foreground/50 hover:text-muted-foreground"
              >
                {expanded ? <CornersIn size={12} /> : <CornersOut size={12} />}
              </Button>
              <span
                className={cn(
                  "text-xs text-muted-foreground/50 select-none transition-opacity duration-150",
                  inputFocused ? "opacity-100" : "opacity-0",
                )}
              >
                ↵ send · ⇧↵ newline
              </span>
            </div>
            <div className="pointer-events-auto flex items-center gap-1.5">
              {isRunning ? (
                <Button variant="destructive" size="xs" onClick={() => cancelPrompt(id)}>
                  cancel
                </Button>
              ) : (
                <Button
                  size="xs"
                  onClick={handleSend}
                  disabled={!input.trim() || isDisconnected}
                >
                  send
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
