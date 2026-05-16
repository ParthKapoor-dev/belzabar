export const runtime = "nodejs"

import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { MatrixData, ReleaseSummary } from "@/lib/release-types"

// Releases are read straight from the promotion ledger that `belz release
// matrix` writes — no belz invocation needed to display past audits.
const RELEASES_DIR = join(homedir(), ".belz", "promotion", "releases")

export async function GET() {
  if (!existsSync(RELEASES_DIR)) {
    return Response.json({ releases: [] as ReleaseSummary[] })
  }

  const releases: ReleaseSummary[] = []
  for (const file of readdirSync(RELEASES_DIR)) {
    if (!file.endsWith(".json")) continue
    try {
      const data = JSON.parse(readFileSync(join(RELEASES_DIR, file), "utf-8")) as MatrixData
      releases.push({
        name: data.name,
        generatedAt: data.generatedAt,
        ticketCount: data.tickets?.length ?? 0,
        itemCount: data.items?.length ?? 0,
        collisionCount: data.collisions?.length ?? 0,
        leakedCount: data.collisions?.filter((c) => c.leak === "leaked").length ?? 0,
      })
    } catch {
      // skip unreadable ledger files
    }
  }

  releases.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1))
  return Response.json({ releases })
}
