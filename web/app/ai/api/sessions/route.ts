export const runtime = "nodejs";

import { bridge } from "@/lib/acp-bridge";

export async function GET() {
  const sessions = bridge.listSessions();
  return Response.json({ sessions });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { agentName, cwd, namespace } = body as { agentName?: string; cwd?: string; namespace?: string };
  if (!agentName || typeof agentName !== "string") {
    return Response.json({ error: "agentName is required" }, { status: 400 });
  }
  if (!cwd || typeof cwd !== "string") {
    return Response.json({ error: "cwd is required" }, { status: 400 });
  }

  try {
    const session = await bridge.createSession(agentName, cwd, namespace || undefined);
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
