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

const STRICT_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

/**
 * Strict base64 decode. Returns the decoded UTF-8 text only when `input` is
 * canonical base64: non-empty, charset [A-Za-z0-9+/] with at most two `=`
 * pad characters, length a multiple of 4, re-encodes to exactly the same
 * string, and decodes to valid UTF-8. Anything else returns `null`, meaning
 * "this is not base64 — treat it as plain text".
 *
 * `Buffer.from(x, "base64")` never throws, so the lenient decoder turns plain
 * JS into garbage. V1 stores custom-code `code` as plain text on most sems-dev
 * steps; the runtime content-sniffs, and so must we.
 */
export function decodeBase64Strict(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length % 4 !== 0) return null;
  if (!STRICT_B64_RE.test(input)) return null;
  const buf = Buffer.from(input, "base64");
  if (buf.toString("base64") !== input) return null;
  try {
    return UTF8_FATAL.decode(buf);
  } catch {
    return null;
  }
}
