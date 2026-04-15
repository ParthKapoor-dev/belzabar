// Tiny, dependency-free base64 helper. Custom-code bodies and SQL strings in
// V1 arrive base64-encoded; the parser decodes them into CustomCodeStep.source
// and SqlStep.sql, and the V1 serializer re-encodes on save. Both paths
// surface decode failures as parseWarnings rather than crashing.

export class Base64DecodeError extends Error {
  constructor(public readonly input: string, cause?: unknown) {
    super(`Failed to base64-decode input of length ${input.length}: ${String(cause)}`);
    this.name = "Base64DecodeError";
  }
}

export function encodeBase64(utf8: string): string {
  return Buffer.from(utf8, "utf-8").toString("base64");
}

/**
 * Decode a base64 string to UTF-8. Throws Base64DecodeError on failure so
 * callers can convert it into a parseWarnings entry.
 */
export function decodeBase64(b64: string): string {
  try {
    return Buffer.from(b64, "base64").toString("utf-8");
  } catch (err) {
    throw new Base64DecodeError(b64, err);
  }
}

/**
 * Decode a base64 string, calling `onWarning` on failure instead of throwing.
 * Returns the original input string so callers can display something.
 */
export function decodeBase64Safe(b64: string, onWarning: (msg: string) => void): string {
  try {
    return decodeBase64(b64);
  } catch (err) {
    const msg = err instanceof Base64DecodeError ? err.message : String(err);
    onWarning(`base64 decode failed (${msg}) — using raw value`);
    return b64;
  }
}
