export const runtime = "nodejs";

import { bridge } from "@/lib/acp-bridge";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = bridge.getSessionInfo(id);
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  return Response.json({ session });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await bridge.closeSession(id);
  return new Response(null, { status: 204 });
}
