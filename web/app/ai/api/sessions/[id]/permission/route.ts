export const runtime = "nodejs";

import { bridge } from "@/lib/acp-bridge";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { requestId, optionId } = body as { requestId?: string; optionId?: string | null };
  if (!requestId || typeof requestId !== "string") {
    return Response.json({ error: "requestId is required" }, { status: 400 });
  }

  bridge.resolvePermission(id, requestId, optionId ?? null);
  return Response.json({ ok: true });
}
