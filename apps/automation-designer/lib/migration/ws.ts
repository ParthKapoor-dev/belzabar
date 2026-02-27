import { CliError } from "@belzabar/core";
import { DB_MIGRATION_TOOL_BASE_URL } from "./constants";
import type { StreamExecutionEvent, StreamExecutionResult } from "./types";

interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

interface StreamExecutionOptions {
  createSocket?: (url: string) => SocketLike;
  timeoutMs?: number;
  onOutputChunk?: (chunk: string) => void;
  headers?: Record<string, string>;
}

function toWebSocketUrl(baseUrl: string, executionId: string): string {
  const url = new URL(`/executions/io/${executionId}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function parseStreamEvent(payload: string): StreamExecutionEvent {
  try {
    const parsed = JSON.parse(payload) as { event?: unknown; data?: unknown };
    let data: string | undefined;
    if (typeof parsed.data === "string") {
      data = parsed.data;
    } else if (parsed.data !== undefined) {
      data = JSON.stringify(parsed.data);
    }

    return {
      raw: payload,
      event: typeof parsed.event === "string" ? parsed.event : undefined,
      data,
    };
  } catch {
    return { raw: payload, data: payload };
  }
}

async function decodeSocketData(data: unknown): Promise<string> {
  const decoder = new TextDecoder();
  if (typeof data === "string") return data;
  if (data instanceof Blob) return await data.text();
  if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return String(data ?? "");
}

export async function streamMigrationExecution(
  executionId: string,
  options: StreamExecutionOptions = {}
): Promise<StreamExecutionResult> {
  const createSocket =
    options.createSocket ||
    ((url: string) => {
      // Bun provides a browser-compatible WebSocket global in runtime.
      return new WebSocket(url, {
        headers: options.headers,
      }) as unknown as SocketLike;
    });

  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const wsUrl = toWebSocketUrl(DB_MIGRATION_TOOL_BASE_URL, executionId);
  const onOutputChunk = options.onOutputChunk;

  const events: StreamExecutionEvent[] = [];
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = createSocket(wsUrl);
    let retrySent = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
      reject(
        new CliError(`Migration websocket timed out after ${timeoutMs}ms.`, {
          code: "MIGRATE_STREAM_TIMEOUT",
          details: { executionId, wsUrl },
        })
      );
    }, timeoutMs);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    socket.onopen = () => {
      try {
        // Send both variants because some backend shells expect newline terminated input.
        socket.send("yes");
        socket.send("yes\n");
        setTimeout(() => {
          if (settled || retrySent || events.length > 0) return;
          retrySent = true;
          try {
            socket.send("yes\n");
          } catch {
            // ignore retry send errors
          }
        }, 1000);
      } catch (error) {
        finish(() => {
          reject(
            new CliError("Failed to send migration confirmation over websocket.", {
              code: "MIGRATE_STREAM_SEND_FAILED",
              details: error instanceof Error ? error.message : String(error),
            })
          );
        });
      }
    };

    socket.onmessage = async (event) => {
      const payload = await decodeSocketData(event.data);
      const parsed = parseStreamEvent(payload);
      events.push(parsed);
      if (onOutputChunk) {
        onOutputChunk(parsed.data || parsed.raw);
      }
    };

    socket.onerror = (event) => {
      finish(() => {
        reject(
          new CliError("Migration websocket reported an error.", {
            code: "MIGRATE_STREAM_ERROR",
            details: { executionId, event },
          })
        );
      });
    };

    socket.onclose = (event) => {
      if (event && typeof event === "object") {
        const maybeEvent = event as { code?: unknown; reason?: unknown };
        if (typeof maybeEvent.code === "number") closeCode = maybeEvent.code;
        if (typeof maybeEvent.reason === "string") closeReason = maybeEvent.reason;
      }
      finish(() => resolve());
    };
  });

  const outputText = events
    .map((event) => event.data || event.raw)
    .filter(Boolean)
    .join("");

  return {
    executionId,
    events,
    outputText,
    closeCode,
    closeReason,
  };
}
