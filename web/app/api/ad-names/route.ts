export const runtime = "nodejs"

import { runBelz, BelzSpawnError } from "@/lib/run-belz"

const VALID_ENVS = ["nsm-dev", "nsm-qa", "nsm-uat", "nsm-stage"] as const
type Env = (typeof VALID_ENVS)[number]

const UUID_RE = /^[0-9a-f]{32}$/i
const MAX_UUIDS = 30
const CONCURRENCY = 4

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

/** The extension's DevTools panel is a cross-origin caller, so it preflights. */
export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

interface ShowEnvelope {
  ok: boolean
  data?: { summary?: { name?: string; category?: string } }
}

interface MethodMeta {
  name: string | null
  category: string | null
}

/**
 * Resolve one method uuid to its name + service category via `belz ad show`.
 * This is cache-backed (stale-while-revalidate): a cached method answers
 * instantly, a miss fetches once and populates ~/.belz/cache/methods/. Returns
 * null on any miss/failure; rethrows {@link BelzSpawnError} so a missing binary
 * surfaces as a 500.
 */
async function resolveMeta(uuid: string, env: Env): Promise<MethodMeta | null> {
  let raw: string
  try {
    raw = await runBelz(["ad", "show", uuid, "--llm", "--env", env])
  } catch (err) {
    if (err instanceof BelzSpawnError) throw err
    return null // BelzExitError — uuid not an AD method on this env; a normal miss
  }
  try {
    const parsed = JSON.parse(raw) as ShowEnvelope
    if (!parsed.ok) return null
    const name = parsed.data?.summary?.name?.trim() || null
    const category = parsed.data?.summary?.category?.trim() || null
    return name || category ? { name, category } : null
  } catch {
    return null
  }
}

/** Resolve uuids with a bounded worker pool so we never spawn 30 `belz` at once. */
async function resolveAll(
  uuids: string[],
  env: Env,
): Promise<Record<string, MethodMeta | null>> {
  const items: Record<string, MethodMeta | null> = {}
  let cursor = 0
  async function worker() {
    while (cursor < uuids.length) {
      const uuid = uuids[cursor++]
      items[uuid] = await resolveMeta(uuid, env)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, uuids.length) }, worker),
  )
  return items
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

  const { uuids, env } = body as Record<string, unknown>

  if (!Array.isArray(uuids)) {
    return Response.json(
      { error: "uuids must be an array" },
      { status: 400, headers: CORS_HEADERS },
    )
  }

  // Keep only well-formed 32-hex uuids, de-duplicated, capped.
  const safeUuids = Array.from(
    new Set(
      uuids
        .filter((u): u is string => typeof u === "string" && UUID_RE.test(u))
        .map((u) => u.toLowerCase()),
    ),
  ).slice(0, MAX_UUIDS)

  const safeEnv: Env = VALID_ENVS.includes(env as Env) ? (env as Env) : "nsm-dev"

  if (safeUuids.length === 0) {
    return Response.json({ items: {} }, { headers: CORS_HEADERS })
  }

  try {
    const items = await resolveAll(safeUuids, safeEnv)
    return Response.json({ items }, { headers: CORS_HEADERS })
  } catch (err) {
    if (err instanceof BelzSpawnError) {
      return Response.json(
        { error: "Could not run the belz CLI — is it installed?" },
        { status: 500, headers: CORS_HEADERS },
      )
    }
    return Response.json(
      { error: "Failed to resolve method names" },
      { status: 500, headers: CORS_HEADERS },
    )
  }
}
