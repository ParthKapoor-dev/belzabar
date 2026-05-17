// Parser for an `application/stream+json` response from an AD streaming method.
//
// A streaming method emits a sequence of text/JSON chunks, then a final JSON
// envelope as the last non-empty line. We accumulate the whole body, split on
// newlines, and treat the last line that parses as JSON as the final response;
// everything before it is a progressive chunk.
//
// parseStreamText is pure and unit-testable; readStream wraps it around a live
// Response body and can forward lines as they arrive.

export interface StreamParseResult {
  /** Progressive chunks emitted before the final envelope. */
  chunks: string[];
  /** The final response — parsed JSON when the last line was JSON, else raw text. */
  final: unknown;
  finalFormat: "json" | "text";
}

/** Split accumulated stream text into progressive chunks + a final envelope. */
export function parseStreamText(text: string): StreamParseResult {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { chunks: [], final: "", finalFormat: "text" };
  }

  const lastLine = lines[lines.length - 1] ?? "";
  try {
    const final: unknown = JSON.parse(lastLine);
    return { chunks: lines.slice(0, -1), final, finalFormat: "json" };
  } catch {
    // No parseable final envelope — treat the whole body as text chunks.
    return { chunks: lines, final: text, finalFormat: "text" };
  }
}

/**
 * Fully read a streaming Response body, optionally forwarding each completed
 * line via `onChunk` as it arrives, then parse it into a StreamParseResult.
 */
export async function readStream(
  response: Response,
  onChunk?: (line: string) => void,
): Promise<StreamParseResult> {
  if (!response.body) {
    return parseStreamText(await response.text());
  }

  const decoder = new TextDecoder();
  let accumulated = "";
  let pending = "";

  for await (const piece of response.body as AsyncIterable<Uint8Array>) {
    const textPiece = decoder.decode(piece, { stream: true });
    accumulated += textPiece;
    if (onChunk) {
      pending += textPiece;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.trim().length > 0) onChunk(line);
      }
    }
  }
  accumulated += decoder.decode();
  if (onChunk && pending.trim().length > 0) onChunk(pending);

  return parseStreamText(accumulated);
}
