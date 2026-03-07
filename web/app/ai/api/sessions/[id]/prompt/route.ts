export const runtime = "nodejs";

import { bridge } from "@/lib/acp-bridge";
import type { BridgeEvent } from "@/lib/acp-types";

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

  const { message } = body as { message?: string };
  if (!message || typeof message !== "string") {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  const session = bridge.getSessionInfo(id);
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  if (session.status === "running") {
    return Response.json({ error: "Session is already running a prompt" }, { status: 409 });
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  const emit = (event: BridgeEvent): void => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    writer.write(encoder.encode(line)).catch(() => {
      // subscriber may have disconnected — ignore
    });
  };

  // Run the prompt in the background; the response stream delivers events as
  // they arrive. We don't await here so the Response is returned immediately.
  bridge
    .sendPrompt(id, message, emit)
    .catch((err: unknown) => {
      // sendPrompt already emits an error event before throwing — nothing more
      // to do here, but swallow to avoid unhandled rejection.
      void err;
    })
    .finally(() => {
      writer.close().catch(() => {});
    });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
