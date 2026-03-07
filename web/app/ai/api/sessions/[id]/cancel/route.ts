export const runtime = "nodejs";

import { bridge } from "@/lib/acp-bridge";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await bridge.cancelPrompt(id);
  return Response.json({ ok: true });
}
