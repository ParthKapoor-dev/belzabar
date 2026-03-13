"use client"

import { useReducer, useEffect, useCallback } from "react"
import type { BridgeEvent, PermissionOption, SessionInfo } from "@/lib/acp-types"

// ─── UI message model ──────────────────────────────────────────────────────────

export type ToolCallState = {
  toolCallId: string
  title: string
  status: string
  kind: string | null
  rawInput: unknown
  rawOutput?: unknown
  content?: unknown
}

export type AssistantMessage = {
  role: "assistant"
  text: string
  thinking: string
  toolCalls: ToolCallState[]
  plan?: Array<{ status: string; content: string }>
  stopReason?: string
  error?: string
}

export type UserMessage = { role: "user"; text: string }
export type Message = UserMessage | AssistantMessage

export type PendingPermission = {
  requestId: string
  toolCall: { title: string; kind: string | null }
  options: PermissionOption[]
}

// ─── Workspace ─────────────────────────────────────────────────────────────────

export const DEFAULT_WORKSPACE_ID = "default"

export type Workspace = {
  id: string
  name: string
  createdAt: string
  collapsed: boolean
}

// ─── Session slot ──────────────────────────────────────────────────────────────

export type ConnectionStatus = "live" | "disconnected"

export type SessionSlot = {
  id: string
  agentName: string
  agentCommand: string
  cwd: string
  name?: string
  namespace?: string
  status: "idle" | "running" | "closed"
  createdAt: string
  workspaceId: string
  connectionStatus: ConnectionStatus
  messages: Message[]
  isRunning: boolean
  pendingPermission: PendingPermission | null
  connectError: string | null
  connecting: boolean
}

// ─── Reducer ───────────────────────────────────────────────────────────────────

type SessionsState = {
  slots: SessionSlot[]
  workspaces: Workspace[]
  initialized: boolean
}

type SessionsAction =
  | { type: "INIT"; slots: SessionSlot[]; workspaces: Workspace[] }
  | { type: "SET_INITIALIZED" }
  | { type: "ADD_SLOT"; slot: SessionSlot }
  | { type: "UPDATE_SLOT"; id: string; patch: Partial<SessionSlot> }
  | { type: "UPDATE_LAST_ASSISTANT"; id: string; fn: (m: AssistantMessage) => AssistantMessage }
  | { type: "APPEND_MESSAGES"; id: string; messages: Message[] }
  | { type: "REMOVE_SLOT"; id: string }
  | { type: "ADD_WORKSPACE"; workspace: Workspace }
  | { type: "UPDATE_WORKSPACE"; id: string; patch: Partial<Workspace> }
  | { type: "REMOVE_WORKSPACE"; id: string }

function reducer(state: SessionsState, action: SessionsAction): SessionsState {
  switch (action.type) {
    case "INIT":
      return { slots: action.slots, workspaces: action.workspaces, initialized: false }

    case "SET_INITIALIZED":
      return { ...state, initialized: true }

    case "ADD_SLOT":
      return { ...state, slots: [action.slot, ...state.slots] }

    case "UPDATE_SLOT":
      return {
        ...state,
        slots: state.slots.map((s) => (s.id === action.id ? { ...s, ...action.patch } : s)),
      }

    case "UPDATE_LAST_ASSISTANT":
      return {
        ...state,
        slots: state.slots.map((slot) => {
          if (slot.id !== action.id) return slot
          const msgs = [...slot.messages]
          const last = msgs[msgs.length - 1]
          if (last?.role === "assistant") msgs[msgs.length - 1] = action.fn(last as AssistantMessage)
          return { ...slot, messages: msgs }
        }),
      }

    case "APPEND_MESSAGES":
      return {
        ...state,
        slots: state.slots.map((s) =>
          s.id === action.id ? { ...s, messages: [...s.messages, ...action.messages] } : s,
        ),
      }

    case "REMOVE_SLOT":
      return { ...state, slots: state.slots.filter((s) => s.id !== action.id) }

    case "ADD_WORKSPACE":
      return { ...state, workspaces: [...state.workspaces, action.workspace] }

    case "UPDATE_WORKSPACE":
      return {
        ...state,
        workspaces: state.workspaces.map((w) =>
          w.id === action.id ? { ...w, ...action.patch } : w,
        ),
      }

    case "REMOVE_WORKSPACE": {
      // Orphaned sessions fall back to default workspace
      const slots = state.slots.map((s) =>
        s.workspaceId === action.id ? { ...s, workspaceId: DEFAULT_WORKSPACE_ID } : s,
      )
      return {
        ...state,
        slots,
        workspaces: state.workspaces.filter((w) => w.id !== action.id),
      }
    }

    default:
      return state
  }
}

// ─── localStorage helpers ──────────────────────────────────────────────────────

type StoredRecord = {
  id: string
  agentName: string
  agentCommand: string
  cwd: string
  name?: string
  namespace?: string
  status: "idle" | "running" | "closed"
  createdAt: string
  workspaceId: string
  messages: Message[]
}

const DEFAULT_WORKSPACE: Workspace = {
  id: DEFAULT_WORKSPACE_ID,
  name: "main",
  createdAt: new Date(0).toISOString(),
  collapsed: false,
}

function ensureDefaultWorkspace(workspaces: Workspace[]): Workspace[] {
  return workspaces.find((w) => w.id === DEFAULT_WORKSPACE_ID)
    ? workspaces
    : [DEFAULT_WORKSPACE, ...workspaces]
}

function loadFromStorage(): { slots: SessionSlot[]; workspaces: Workspace[] } {
  try {
    const rawSessions = localStorage.getItem("ai:sessions")
    const rawWorkspaces = localStorage.getItem("ai:workspaces")

    const workspaces = ensureDefaultWorkspace(
      rawWorkspaces ? (JSON.parse(rawWorkspaces) as Workspace[]) : [],
    )

    const slots: SessionSlot[] = rawSessions
      ? (JSON.parse(rawSessions) as StoredRecord[]).map((r) => ({
          ...r,
          workspaceId: r.workspaceId ?? DEFAULT_WORKSPACE_ID,
          connectionStatus: "disconnected" as ConnectionStatus,
          isRunning: false,
          pendingPermission: null,
          connectError: null,
          connecting: false,
        }))
      : []

    return { slots, workspaces }
  } catch {
    return { slots: [], workspaces: [DEFAULT_WORKSPACE] }
  }
}

function saveToStorage(state: SessionsState) {
  try {
    const records: StoredRecord[] = state.slots.map((s) => ({
      id: s.id,
      agentName: s.agentName,
      agentCommand: s.agentCommand,
      cwd: s.cwd,
      name: s.name,
      namespace: s.namespace,
      status: s.status,
      createdAt: s.createdAt,
      workspaceId: s.workspaceId,
      messages: s.messages.slice(-200),
    }))
    localStorage.setItem("ai:sessions", JSON.stringify(records))
    localStorage.setItem("ai:workspaces", JSON.stringify(state.workspaces))
  } catch {
    // quota exceeded — silently skip
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSessionName(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ")
  if (trimmed.length <= 52) return trimmed
  const cut = trimmed.slice(0, 52)
  const lastSpace = cut.lastIndexOf(" ")
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + "…"
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

export function useSessions() {
  const [state, dispatch] = useReducer(reducer, {
    slots: [],
    workspaces: [DEFAULT_WORKSPACE],
    initialized: false,
  })

  // Mount: load from localStorage then reconcile with server
  useEffect(() => {
    const { slots, workspaces } = loadFromStorage()
    dispatch({ type: "INIT", slots, workspaces })

    fetch("/ai/api/sessions")
      .then((r) => r.json())
      .then((data: { sessions: SessionInfo[] }) => {
        const localIds = new Set(slots.map((s) => s.id))
        for (const s of data.sessions) {
          if (localIds.has(s.id)) {
            dispatch({ type: "UPDATE_SLOT", id: s.id, patch: { connectionStatus: "live", status: s.status } })
          } else {
            dispatch({
              type: "ADD_SLOT",
              slot: {
                ...s,
                workspaceId: DEFAULT_WORKSPACE_ID,
                connectionStatus: "live",
                messages: [],
                isRunning: false,
                pendingPermission: null,
                connectError: null,
                connecting: false,
              },
            })
          }
        }
      })
      .catch(() => {})
      .finally(() => dispatch({ type: "SET_INITIALIZED" }))
  }, [])

  // Persist on every state change
  useEffect(() => {
    if (state.initialized) saveToStorage(state)
  }, [state])

  // ─── Session actions ─────────────────────────────────────────────────────────

  const createSession = useCallback(
    async (cwd: string, agentName = "opencode", workspaceId = DEFAULT_WORKSPACE_ID, namespace?: string): Promise<string | null> => {
      try {
        const res = await fetch("/ai/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName, cwd, namespace }),
        })
        const data = (await res.json()) as { session?: SessionInfo; error?: string }
        if (!res.ok) throw new Error(data.error ?? "Failed to start session")
        const s = data.session!
        dispatch({
          type: "ADD_SLOT",
          slot: {
            ...s,
            workspaceId,
            connectionStatus: "live",
            messages: [],
            isRunning: false,
            pendingPermission: null,
            connectError: null,
            connecting: false,
          },
        })
        return s.id
      } catch {
        return null
      }
    },
    [],
  )

  const removeSession = useCallback(
    async (id: string) => {
      fetch(`/ai/api/sessions/${id}`, { method: "DELETE" }).catch(() => {})
      dispatch({ type: "REMOVE_SLOT", id })
    },
    [],
  )

  const sendPrompt = useCallback(
    async (id: string, text: string) => {
      const slot = state.slots.find((s) => s.id === id)
      if (!slot || slot.isRunning || slot.connectionStatus !== "live" || !text.trim()) return

      dispatch({ type: "UPDATE_SLOT", id, patch: {
        isRunning: true,
        // Auto-name from first message if no name yet
        ...(!slot.name && slot.messages.length === 0 && { name: makeSessionName(text) }),
      } })
      dispatch({
        type: "APPEND_MESSAGES",
        id,
        messages: [
          { role: "user", text } satisfies UserMessage,
          { role: "assistant", text: "", thinking: "", toolCalls: [] } satisfies AssistantMessage,
        ],
      })

      const upd = (fn: (m: AssistantMessage) => AssistantMessage) =>
        dispatch({ type: "UPDATE_LAST_ASSISTANT", id, fn })

      try {
        const res = await fetch(`/ai/api/sessions/${id}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        })
        if (!res.ok || !res.body) {
          if (res.status === 404) {
            dispatch({ type: "UPDATE_SLOT", id, patch: { connectionStatus: "disconnected" } })
          }
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error ?? "Prompt request failed")
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split("\n")
          buf = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const json = line.slice(6).trim()
            if (!json) continue
            let ev: BridgeEvent | null = null
            try { ev = JSON.parse(json) as BridgeEvent } catch { continue }
            if (!ev) continue

            switch (ev.type) {
              case "agent_message_chunk":
                upd((m) => ({ ...m, text: m.text + ev.text })); break
              case "agent_thought_chunk":
                upd((m) => ({ ...m, thinking: m.thinking + ev.text })); break
              case "tool_call": {
                const tc: ToolCallState = {
                  toolCallId: ev.toolCallId, title: ev.title,
                  status: ev.status, kind: ev.kind, rawInput: ev.rawInput,
                }
                upd((m) => {
                  const idx = m.toolCalls.findIndex((t) => t.toolCallId === ev.toolCallId)
                  if (idx >= 0) { const tcs = [...m.toolCalls]; tcs[idx] = { ...tcs[idx], ...tc }; return { ...m, toolCalls: tcs } }
                  return { ...m, toolCalls: [...m.toolCalls, tc] }
                }); break
              }
              case "tool_call_update":
                upd((m) => {
                  const idx = m.toolCalls.findIndex((t) => t.toolCallId === ev.toolCallId)
                  if (idx < 0) return m
                  const tcs = [...m.toolCalls]
                  tcs[idx] = { ...tcs[idx], ...(ev.title !== undefined && { title: ev.title }), status: ev.status, rawOutput: ev.rawOutput, content: ev.content }
                  return { ...m, toolCalls: tcs }
                }); break
              case "plan":
                upd((m) => ({ ...m, plan: ev.entries })); break
              case "permission_request":
                dispatch({ type: "UPDATE_SLOT", id, patch: { pendingPermission: { requestId: ev.requestId, toolCall: ev.toolCall, options: ev.options } } }); break
              case "done":
                upd((m) => ({ ...m, stopReason: ev.stopReason }))
                dispatch({ type: "UPDATE_SLOT", id, patch: { pendingPermission: null } }); break
              case "session_name":
                dispatch({ type: "UPDATE_SLOT", id, patch: { name: ev.name } }); break
              case "error":
                upd((m) => ({ ...m, error: ev.message })); break
            }
          }
        }
      } catch (err) {
        upd((m) => ({ ...m, error: err instanceof Error ? err.message : String(err) }))
      } finally {
        dispatch({ type: "UPDATE_SLOT", id, patch: { isRunning: false } })
      }
    },
    [state.slots],
  )

  const cancelPrompt = useCallback(async (id: string) => {
    await fetch(`/ai/api/sessions/${id}/cancel`, { method: "POST" }).catch(() => {})
  }, [])

  const resolvePermission = useCallback(
    async (id: string, optionId: string | null) => {
      const slot = state.slots.find((s) => s.id === id)
      if (!slot?.pendingPermission) return
      const { requestId } = slot.pendingPermission
      dispatch({ type: "UPDATE_SLOT", id, patch: { pendingPermission: null } })
      await fetch(`/ai/api/sessions/${id}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, optionId }),
      }).catch(() => {})
    },
    [state.slots],
  )

  // ─── Workspace actions ───────────────────────────────────────────────────────

  const createWorkspace = useCallback((name: string): string => {
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      collapsed: false,
    }
    dispatch({ type: "ADD_WORKSPACE", workspace })
    return workspace.id
  }, [])

  const removeWorkspace = useCallback((id: string) => {
    if (id === DEFAULT_WORKSPACE_ID) return
    dispatch({ type: "REMOVE_WORKSPACE", id })
  }, [])

  const toggleWorkspace = useCallback((id: string) => {
    const w = state.workspaces.find((w) => w.id === id)
    if (w) dispatch({ type: "UPDATE_WORKSPACE", id, patch: { collapsed: !w.collapsed } })
  }, [state.workspaces])

  const renameWorkspace = useCallback((id: string, name: string) => {
    dispatch({ type: "UPDATE_WORKSPACE", id, patch: { name } })
  }, [])

  return {
    slots: state.slots,
    workspaces: state.workspaces,
    initialized: state.initialized,
    createSession,
    removeSession,
    sendPrompt,
    cancelPrompt,
    resolvePermission,
    createWorkspace,
    removeWorkspace,
    toggleWorkspace,
    renameWorkspace,
  }
}
