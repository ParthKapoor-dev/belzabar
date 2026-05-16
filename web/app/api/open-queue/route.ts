export const runtime = "nodejs"

// In-memory inbox of "open in draft" requests sent from the AD Network DevTools
// panel. The panel is the producer (cross-origin POST); the /queue page is the
// consumer (same-origin GET poll). The inbox is just a mailbox — all processing
// state lives in the /queue page.

const VALID_ENVS = ["nsm-dev", "nsm-qa", "nsm-uat", "nsm-stage"] as const
type Env = (typeof VALID_ENVS)[number]

const UUID_RE = /^[0-9a-f]{32}$/i
const MAX_ITEMS = 100

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

interface QueueItem {
  id: number
  uuid: string
  body: string
  env: Env
  ts: number
}

// Module-level state survives between requests within a running server.
const inbox: QueueItem[] = []
let counter = 0

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
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

  const { uuid, body: reqBody, env } = body as Record<string, unknown>

  if (typeof uuid !== "string" || !UUID_RE.test(uuid)) {
    return Response.json(
      { error: "uuid must be a 32-hex string" },
      { status: 400, headers: CORS_HEADERS },
    )
  }
  const safeEnv: Env = VALID_ENVS.includes(env as Env) ? (env as Env) : "nsm-dev"
  const safeBody = typeof reqBody === "string" ? reqBody.slice(0, 200_000) : ""

  const item: QueueItem = {
    id: ++counter,
    uuid: uuid.toLowerCase(),
    body: safeBody,
    env: safeEnv,
    ts: Date.now(),
  }
  inbox.push(item)
  if (inbox.length > MAX_ITEMS) inbox.splice(0, inbox.length - MAX_ITEMS)

  return Response.json({ id: item.id }, { headers: CORS_HEADERS })
}

export function GET() {
  return Response.json({ items: inbox }, { headers: CORS_HEADERS })
}
