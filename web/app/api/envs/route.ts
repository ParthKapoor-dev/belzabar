export const runtime = "nodejs"

import { runBelz, BelzSpawnError } from "@/lib/run-belz"
import type { KnownEnv } from "@/lib/envs"

// The AD Network DevTools panel calls this route cross-origin to learn which
// environments exist and which host maps to which env — so it can detect the
// right env from the inspected page's hostname instead of guessing NSM.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

interface EnvsEnvelope {
  ok: boolean
  data?: {
    active?: string
    envs?: { name?: string; project?: string; baseUrl?: string; active?: boolean }[]
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}

export async function GET() {
  let raw: string
  try {
    raw = await runBelz(["envs", "--llm"])
  } catch (err) {
    const status = err instanceof BelzSpawnError ? 500 : 502
    return Response.json(
      { error: "Could not list environments from the belz CLI." },
      { status, headers: CORS_HEADERS },
    )
  }

  let parsed: EnvsEnvelope
  try {
    parsed = JSON.parse(raw) as EnvsEnvelope
  } catch {
    return Response.json(
      { error: "belz returned malformed env output." },
      { status: 502, headers: CORS_HEADERS },
    )
  }

  const envs: KnownEnv[] = (parsed.data?.envs ?? [])
    .filter((e) => typeof e.name === "string" && e.name)
    .map((e) => ({
      name: e.name as string,
      host: hostOf(e.baseUrl ?? ""),
      baseUrl: e.baseUrl ?? "",
      project: e.project ?? "",
      active: Boolean(e.active),
    }))

  return Response.json(
    { active: parsed.data?.active ?? null, envs },
    { headers: CORS_HEADERS },
  )
}
