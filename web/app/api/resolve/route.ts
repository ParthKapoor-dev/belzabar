export const runtime = "nodejs"

import { runBelz, BelzSpawnError } from "@/lib/run-belz"

const VALID_ENVS = ["nsm-dev", "nsm-qa", "nsm-uat", "nsm-stage"] as const
type Env = (typeof VALID_ENVS)[number]

type Kind = "ad" | "pd"

// The AD Network DevTools panel calls this route cross-origin.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

interface ShowEnvelope {
  ok: boolean
  data?: {
    summary?: {
      editUrl?: string | null
      name?: string
      entityType?: string
    }
  }
  error?: unknown
}

interface Resolved {
  kind: Kind
  editUrl: string
  label: string
  name: string
}

/**
 * Run `belz <kind> show <text> --llm` and pull out an editable URL.
 * Returns null when the command resolves nothing (non-zero exit, or no editUrl).
 * Rethrows {@link BelzSpawnError} so a missing binary surfaces as a 500.
 */
async function tryShow(kind: Kind, text: string, env: string): Promise<Resolved | null> {
  let raw: string
  try {
    raw = await runBelz([kind, "show", text, "--llm", "--env", env])
  } catch (err) {
    if (err instanceof BelzSpawnError) throw err
    return null // BelzExitError — e.g. "not an AD method"; a normal miss
  }
  let parsed: ShowEnvelope
  try {
    parsed = JSON.parse(raw) as ShowEnvelope
  } catch {
    return null
  }
  if (!parsed.ok) return null
  const editUrl = parsed.data?.summary?.editUrl
  if (typeof editUrl !== "string" || !editUrl) return null
  const name = parsed.data?.summary?.name?.trim() || text
  const label = kind === "ad" ? `AD · ${name}` : `PD · ${name}`
  return { kind, editUrl, label, name }
}

/** Decide which show command(s) could resolve this input. */
function candidateKinds(text: string): Kind[] {
  if (/^https?:\/\//i.test(text)) {
    if (/\/ui-designer\/(page|symbol)\//i.test(text)) return ["pd"]
    if (/\/automation-designer\//i.test(text) || /\/execute\/[0-9a-f]{32}/i.test(text)) return ["ad"]
    return ["pd"] // an app page URL — Page Designer
  }
  if (/^[0-9a-f]{32}$/i.test(text)) return ["ad", "pd"] // 32-hex is ambiguous
  return ["pd"] // free-text name — only `pd show` resolves names
}

/** Reject text containing ASCII control characters (newlines, tabs, etc.). */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x20) return true
  }
  return false
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: CORS_HEADERS },
    )
  }

  const { text, env } = body as Record<string, unknown>

  if (typeof text !== "string" || !text.trim()) {
    return Response.json(
      { error: "text is required" },
      { status: 400, headers: CORS_HEADERS },
    )
  }
  const safeText = text.trim().slice(0, 2000)
  if (hasControlChars(safeText)) {
    return Response.json(
      { resolved: false, reason: "Input contains control characters" },
      { headers: CORS_HEADERS },
    )
  }
  const safeEnv: Env = VALID_ENVS.includes(env as Env) ? (env as Env) : "nsm-dev"

  const kinds = candidateKinds(safeText)
  const settled = await Promise.allSettled(kinds.map((k) => tryShow(k, safeText, safeEnv)))

  const spawnFailed = settled.some(
    (r) => r.status === "rejected" && r.reason instanceof BelzSpawnError,
  )
  // First successful resolution, in candidate priority order.
  let hit: Resolved | null = null
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      hit = r.value
      break
    }
  }

  if (hit) {
    return Response.json({ resolved: true, ...hit }, { headers: CORS_HEADERS })
  }
  if (spawnFailed) {
    return Response.json(
      { error: "Could not run the belz CLI — is it installed?" },
      { status: 500, headers: CORS_HEADERS },
    )
  }
  return Response.json(
    {
      resolved: false,
      reason: `No AD or PD item matched on ${safeEnv}`,
    },
    { headers: CORS_HEADERS },
  )
}
