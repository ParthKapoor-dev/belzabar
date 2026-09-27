// Fixture sanitizer + secret scanner.
//
// Used by `capture.ts` before anything is written to disk, and by
// `fixtures-secrets.test.ts`, which scans every committed fixture dir.
//
// Rules (structure is always preserved — only string *values* change):
//   1. Secret-named keys (password, token, cookie, authorization, secret,
//      apiKey, Expertly-Auth-Token, tw-auth, …) → "REDACTED" when non-empty.
//   2. JWTs (eyJ….….…)                          → "REDACTED_JWT"
//   3. `Bearer <token>` / `Basic <b64>`          → "Bearer REDACTED" / "Basic REDACTED"
//   4. `tw-auth=<v>` / `JSESSIONID=<v>` cookies   → "<name>=REDACTED"
//   5. e-mail addresses (not example.com/.org)   → "user@example.com"
//   6. phone numbers with separators             → "555-555-0100"
//   7. credential records {fieldName, fieldValue, securedField} (AD automation
//      auths) and {name|key, value} header pairs: the value → "REDACTED" when
//      securedField is true or the name is secret-ish (password, username,
//      host, token, key, …).
//   8. strings that hold JSON (PD `configuration`, AD `jsonDefinition`) are
//      parsed, sanitized recursively and re-stringified — but ONLY when a rule
//      fired inside them; untouched strings stay byte-identical so the
//      round-trip tests still see the real wire bytes.

export const SECRET_KEY_RE =
  /^(password|passwd|pwd|secret|client_?secret|api_?key|x-api-key|token|access_?token|refresh_?token|auth_?token|id_?token|session_?token|authorization|cookie|set-cookie|tw-?auth|expertly-auth-token|private_?key)$/i;

export const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /\b(Bearer|Basic)\s+(?!REDACTED\b)[A-Za-z0-9._~+/=-]{16,}/g;
const COOKIE_RE = /\b(tw-auth|JSESSIONID|SESSION)=(?!REDACTED\b)[^;\s"'&]{8,}/gi;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Needs separators between the groups, so hex ids / timestamps / dates never match.
export const PHONE_RE = /(?<![\w.-])(?:\+?1[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w-])/g;

/** Names inside {fieldName,fieldValue} / {name,value} records whose value is sensitive. */
export const SECRET_FIELD_NAME_RE =
  /^(password|passwd|pwd|username|user|login|host|hostname|secret|client_?secret|client_?id|api_?key|x-api-key|key|token|access_?token|refresh_?token|auth_?token|authorization|cookie|private_?key|connection_?string|url)$/i;

const SAFE_EMAIL_DOMAINS = /^user\d*@example\.com$|@(example\.(com|org|net)|[a-z0-9-]+\.example)$/i;
export const SAFE_PHONE = "555-555-0100";

export function isSafeEmail(e: string): boolean {
  return SAFE_EMAIL_DOMAINS.test(e);
}

function scrubString(s: string): string {
  let out = s
    .replace(JWT_RE, "REDACTED_JWT")
    .replace(BEARER_RE, (_m, kind) => `${kind} REDACTED`)
    .replace(COOKIE_RE, (_m, name) => `${name}=REDACTED`)
    .replace(EMAIL_RE, (m) => (isSafeEmail(m) ? m : "user@example.com"))
    .replace(PHONE_RE, (m) => (m === SAFE_PHONE ? m : SAFE_PHONE));
  return out;
}

function looksLikeJson(s: string): boolean {
  if (s.length < 2) return false;
  const c = s.trimStart()[0];
  return c === "{" || c === "[";
}

export interface SanitizeStats {
  redactedKeys: number;
  scrubbedStrings: number;
  reencodedJsonStrings: number;
}

export function sanitize<T>(value: T, stats: SanitizeStats = { redactedKeys: 0, scrubbedStrings: 0, reencodedJsonStrings: 0 }): T {
  return walk(value, stats) as T;
}

function walk(v: unknown, stats: SanitizeStats): unknown {
  if (typeof v === "string") return sanitizeString(v, stats);
  if (Array.isArray(v)) return v.map((x) => walk(x, stats));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    const obj = v as Record<string, unknown>;
    // Auth records: broad name list. Generic {name|key, value} pairs: only real secret names.
    const isAuthRecord = typeof obj.fieldName === "string" && "fieldValue" in obj;
    const pairName = !isAuthRecord && "value" in obj && Object.keys(obj).length <= 4
      ? (typeof obj.name === "string" ? obj.name : typeof obj.key === "string" ? obj.key : null)
      : null;
    const recValueKey = isAuthRecord ? "fieldValue" : "value";
    const redactRecord = isAuthRecord
      ? obj.securedField === true || SECRET_FIELD_NAME_RE.test(obj.fieldName as string)
      : pairName !== null && SECRET_KEY_RE.test(pairName);
    for (const [k, val] of Object.entries(obj)) {
      if (redactRecord && k === recValueKey && typeof val === "string" && val !== "" && val !== "REDACTED") {
        out[k] = "REDACTED";
        stats.redactedKeys++;
        continue;
      }
      // Keys can carry PII too (e.g. test data keyed by e-mail address).
      let key = scrubString(k);
      if (key !== k) {
        stats.scrubbedStrings++;
        for (let n = 2; key in out; n++) key = scrubString(k).replace("user@", `user${n}@`);
      }
      if (SECRET_KEY_RE.test(k) && typeof val === "string" && val !== "" && val !== "REDACTED") {
        out[key] = "REDACTED";
        stats.redactedKeys++;
      } else {
        out[key] = walk(val, stats);
      }
    }
    return out;
  }
  return v;
}

function sanitizeString(s: string, stats: SanitizeStats): string {
  if (looksLikeJson(s)) {
    try {
      const parsed = JSON.parse(s);
      const inner: SanitizeStats = { redactedKeys: 0, scrubbedStrings: 0, reencodedJsonStrings: 0 };
      const cleaned = walk(parsed, inner);
      const fired = inner.redactedKeys + inner.scrubbedStrings + inner.reencodedJsonStrings;
      if (fired === 0) return s; // untouched → keep exact bytes
      stats.redactedKeys += inner.redactedKeys;
      stats.scrubbedStrings += inner.scrubbedStrings;
      stats.reencodedJsonStrings += inner.reencodedJsonStrings + 1;
      return JSON.stringify(cleaned);
    } catch {
      // not JSON after all — fall through to plain scrubbing
    }
  }
  const out = scrubString(s);
  if (out !== s) stats.scrubbedStrings++;
  return out;
}

/** Plain-text sanitizer (console logs etc.). */
export function sanitizeText(s: string): string {
  return scrubString(s);
}

export interface SecretFinding {
  kind: "jwt" | "bearer" | "cookie" | "email" | "phone" | "secret-key";
  match: string;
}

/** Scan raw file text for anything the sanitizer should have removed. */
export function findSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const m of text.match(JWT_RE) ?? []) found.push({ kind: "jwt", match: m.slice(0, 24) });
  for (const m of text.match(BEARER_RE) ?? []) found.push({ kind: "bearer", match: m.slice(0, 24) });
  for (const m of text.match(COOKIE_RE) ?? []) found.push({ kind: "cookie", match: m.slice(0, 24) });
  for (const m of text.match(EMAIL_RE) ?? []) if (!isSafeEmail(m)) found.push({ kind: "email", match: m });
  for (const m of text.match(PHONE_RE) ?? []) if (m !== SAFE_PHONE) found.push({ kind: "phone", match: m });
  // "password":"<non-empty, non-REDACTED>" in JSON text (also inside escaped JSON strings).
  const keyRe = /\\?"(password|passwd|client_?secret|api_?key|access_?token|refresh_?token|auth_?token|authorization|cookie|tw-?auth|expertly-auth-token)\\?"\s*:\s*\\?"(?!REDACTED)([^"\\]+)/gi;
  for (const m of text.matchAll(keyRe)) found.push({ kind: "secret-key", match: `${m[1]}=${m[2]!.slice(0, 8)}…` });
  // {"fieldName": "password", "fieldValue": "<not REDACTED>"} credential records.
  const recRe = /\\?"fieldName\\?"\s*:\s*\\?"([^"\\]+)\\?"\s*,\s*\\?"fieldValue\\?"\s*:\s*\\?"(?!REDACTED)([^"\\]+)/g;
  for (const m of text.matchAll(recRe)) {
    if (SECRET_FIELD_NAME_RE.test(m[1]!)) found.push({ kind: "secret-key", match: `${m[1]}=${m[2]!.slice(0, 8)}…` });
  }
  return found;
}
