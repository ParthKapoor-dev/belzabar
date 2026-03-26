export const runtime = "nodejs"

import { spawn } from "node:child_process"
import { homedir } from "node:os"

const VALID_ENVS = ["nsm-dev", "nsm-qa", "nsm-uat"] as const
type Env = (typeof VALID_ENVS)[number]

function runBelz(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("belz", args, {
      env: {
        ...process.env,
        PATH: `${homedir()}/.local/bin:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
      },
    })

    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString() })
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `belz exited with code ${code}`))
      else resolve(stdout.trim())
    })
    proc.on("error", (err) => reject(err))
  })
}

interface AdMatch {
  type: "method" | "category"
  score: number
  uuid: string
  methodName?: string
  aliasName?: string
  categoryName?: string
  state?: string
  url?: string
  referenceId?: string
  name?: string
  label?: string
  methodCount?: number
  aliasNames?: string[]
}

interface PdMatch {
  type: "page" | "component"
  score: number
  id: string
  name: string
  url: string
  relativeRoute?: string
  referenceId?: string
  status?: string
}

interface AdResult {
  matches: AdMatch[]
  cache: { source: string; methodCount: number; categoryCount: number } | null
  error?: string
}

interface PdResult {
  matches: PdMatch[]
  cache: { source: string; pageCount: number; componentCount: number } | null
  error?: string
}

async function searchAd(query: string, env: string, limit: number): Promise<AdResult> {
  try {
    const raw = await runBelz(["ad", "find", query, "--llm", "--env", env, "--limit", String(limit)])
    const parsed = JSON.parse(raw) as {
      ok: boolean
      data?: {
        matches?: AdMatch[]
        cache?: { source: string; methodCount: number; categoryCount: number }
      }
      error?: unknown
    }
    if (!parsed.ok) {
      return { matches: [], cache: null, error: String(parsed.error ?? "AD search failed") }
    }
    return {
      matches: parsed.data?.matches ?? [],
      cache: parsed.data?.cache
        ? { source: parsed.data.cache.source, methodCount: parsed.data.cache.methodCount, categoryCount: parsed.data.cache.categoryCount }
        : null,
    }
  } catch (err) {
    return { matches: [], cache: null, error: err instanceof Error ? err.message : "AD search failed" }
  }
}

async function searchPd(query: string, env: string, limit: number): Promise<PdResult> {
  try {
    const raw = await runBelz(["pd", "find", query, "--llm", "--env", env, "--limit", String(limit)])
    const parsed = JSON.parse(raw) as {
      ok: boolean
      data?: {
        matches?: PdMatch[]
        cache?: { source: string; pageCount: number; componentCount: number }
      }
      error?: unknown
    }
    if (!parsed.ok) {
      return { matches: [], cache: null, error: String(parsed.error ?? "PD search failed") }
    }
    return {
      matches: parsed.data?.matches ?? [],
      cache: parsed.data?.cache
        ? { source: parsed.data.cache.source, pageCount: parsed.data.cache.pageCount, componentCount: parsed.data.cache.componentCount }
        : null,
    }
  } catch (err) {
    return { matches: [], cache: null, error: err instanceof Error ? err.message : "PD search failed" }
  }
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { query, env, limit } = body as Record<string, unknown>

  if (typeof query !== "string" || !query.trim()) {
    return Response.json({ error: "query is required" }, { status: 400 })
  }

  const safeQuery = query.trim().slice(0, 200)
  const safeEnv: Env = VALID_ENVS.includes(env as Env) ? (env as Env) : "nsm-dev"
  const safeLimit = Math.min(Math.max(1, typeof limit === "number" ? limit : 20), 50)

  const [adResult, pdResult] = await Promise.all([
    searchAd(safeQuery, safeEnv, safeLimit),
    searchPd(safeQuery, safeEnv, safeLimit),
  ])

  return Response.json({ ad: adResult, pd: pdResult })
}
