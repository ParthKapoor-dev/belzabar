export const runtime = "nodejs";

import fs from "node:fs/promises";
import path from "node:path";

export async function GET() {
  const dir = path.join(process.cwd(), "..", "specs", "main-orchestrator", "namespaces");
  const files = await fs.readdir(dir).catch(() => []);
  const namespaces = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
  return Response.json({ namespaces });
}
