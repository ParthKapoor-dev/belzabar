// Secret redaction for anything belz logs, caches, or puts into error details.
//
// The AD debug-mode test endpoint echoes the request headers back in its
// response (Authorization: Bearer <jwt>, Expertly-Auth-Token), Jenkins error
// pages embed the CSRF crumb, and login failures used to embed whole response
// bodies. Everything that leaves the process through a log line, a cache file
// or an envelope's error.details goes through redactSecrets() first.

export const REDACTED = "[REDACTED]";

/** Object keys whose values are always secret (case-insensitive, `-`/`_` ignored). */
const SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "expertlyauthtoken",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "pwd",
  "secret",
  "clientsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "apikey",
  "xapikey",
  "twauth",
  "crumb",
  "jenkinscrumb",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/** Only credential-carrying header names (for payloads with legitimate "token"/"password" data fields). */
const HEADER_SECRET_KEYS = new Set(["authorization", "proxyauthorization", "expertlyauthtoken", "cookie", "setcookie"]);

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(normalizeKey(key));
}

export interface RedactOptions {
  /**
   * "all" (default): every secret-looking key (password, token, cookie, …).
   * "headers": only Authorization / Expertly-Auth-Token / Cookie keys — use for
   * business payloads (AD test outputs) whose "token"/"password" fields are data.
   * Strings are scrubbed (Bearer, JWT, header lines) in both modes.
   */
  keys?: "all" | "headers";
}

// Order matters: specific header/cookie forms first, bare JWTs last.
const STRING_RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // Authorization: Bearer xxx / Basic xxx (header line, JSON value, or bare)
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, (_m, scheme) => `${scheme} ${REDACTED}`],
  // Header lines: "Expertly-Auth-Token: xxx", "Cookie: a=b; c=d", "Authorization: xxx"
  [
    /\b(Expertly-Auth-Token|Authorization|Cookie|Set-Cookie|Jenkins-Crumb|refresh-token)(\s*[:=]\s*)(?!\[REDACTED\])[^\r\n,"'}\]]+/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`,
  ],
  // Cookie pairs that carry sessions: tw-auth=..., JSESSIONID=...
  [/\b(tw-auth|JSESSIONID[\w.-]*)=[^;\s,"']+/gi, (_m, name) => `${name}=${REDACTED}`],
  // JSON-ish "password": "..." / "token": "..." inside a string body.
  [
    /(["']?)(password|passwd|pwd|secret|token|accessToken|refreshToken|authToken|apiKey|crumb|twAuth)\1(\s*[:=]\s*)(["'])(?:\\.|(?!\4).)*\4/gi,
    (_m, q, key, sep, vq) => `${q}${key}${q}${sep}${vq}${REDACTED}${vq}`,
  ],
  // Bare JWTs anywhere.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, REDACTED],
];

/** Redact secrets inside a free-form string (headers dumps, bodies, messages). */
export function redactString(value: string): string {
  let out = value;
  for (const [re, rep] of STRING_RULES) {
    out = out.replace(re, rep as any);
  }
  return out;
}

/**
 * Deep-copy `value` with secrets replaced by "[REDACTED]":
 * - object/Map/Headers entries whose key looks secret (Authorization,
 *   Expertly-Auth-Token, Cookie, password, token, …) lose their value;
 * - every string is scrubbed of Bearer/Basic credentials, JWTs, session
 *   cookies and `"password": "…"` fragments.
 * Never mutates the input. Cycles are cut.
 */
export function redactSecrets<T>(value: T, options: RedactOptions = {}): T {
  const isSecret = options.keys === "headers" ? (k: string) => HEADER_SECRET_KEYS.has(normalizeKey(k)) : isSecretKey;
  return redactInner(value, new WeakSet(), isSecret) as T;
}

function redactInner(value: unknown, seen: WeakSet<object>, isSecret: (k: string) => boolean): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (typeof Headers !== "undefined" && value instanceof Headers) {
    const out: Record<string, string> = {};
    value.forEach((v, k) => {
      out[k] = isSecret(k) ? REDACTED : redactString(v);
    });
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redactInner(v, seen, isSecret));
  if (value instanceof Map) {
    const out = new Map();
    for (const [k, v] of value) out.set(k, typeof k === "string" && isSecret(k) ? REDACTED : redactInner(v, seen, isSecret));
    return out;
  }
  if (value instanceof Error) {
    const err = new Error(redactString(value.message));
    err.name = value.name;
    return err;
  }
  if (value instanceof Date || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecret(k) && v !== null && v !== undefined && v !== "") {
      out[k] = REDACTED;
    } else {
      out[k] = redactInner(v, seen, isSecret);
    }
  }
  return out;
}
