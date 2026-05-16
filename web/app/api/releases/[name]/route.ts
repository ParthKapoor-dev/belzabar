export const runtime = "nodejs"

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { MatrixData } from "@/lib/release-types"

const RELEASES_DIR = join(homedir(), ".belz", "promotion", "releases")

// Same slug rule as integrations/release/lib/ledger.ts. Also kills path
// separators, so this doubles as path-traversal protection.
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const path = join(RELEASES_DIR, `${slug(name)}.json`)

  if (!existsSync(path)) {
    return Response.json({ error: `Release '${name}' not found` }, { status: 404 })
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as MatrixData
    return Response.json(data)
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Could not read release" },
      { status: 500 },
    )
  }
}
