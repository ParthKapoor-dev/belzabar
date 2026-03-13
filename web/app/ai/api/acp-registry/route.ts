import { NextResponse } from "next/server"

type AgentEntry = {
  id: string
  name: string
  description?: string
  icon?: string
}

const cache: { data: AgentEntry[]; expiresAt: number } = { data: [], expiresAt: 0 }

export async function GET() {
  if (Date.now() < cache.expiresAt) {
    return NextResponse.json({ agents: cache.data })
  }
  try {
    const res = await fetch(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
      { next: { revalidate: 3600 } },
    )
    if (!res.ok) throw new Error(`status ${res.status}`)
    const raw: unknown = await res.json()
    const agents: AgentEntry[] = Array.isArray(raw)
      ? (raw as AgentEntry[])
      : ((raw as { agents?: AgentEntry[] }).agents ?? [])
    cache.data = agents
    cache.expiresAt = Date.now() + 3600 * 1000
    return NextResponse.json({ agents })
  } catch {
    return NextResponse.json({ agents: cache.data })
  }
}
