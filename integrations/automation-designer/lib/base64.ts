// Tiny, dependency-free base64 helpers. Custom-code bodies and SQL strings may
// arrive base64-encoded; the parsers decode them (strictly: plain text is left
// alone) into CustomCodeStep.source and SqlStep.sql, and the V2 save pipeline
// re-encodes a slot that was stored encoded.

export function encodeBase64(utf8: string): string {
  return Buffer.from(utf8, "utf-8").toString("base64");
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
