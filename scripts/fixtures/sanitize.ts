import { readFileSync } from "fs";

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
//   8. person names, deterministically pseudonymized so the same
//      person maps to the same pseudonym in every fixture:
//      - objects with firstName/lastName/fullName (AD owner/createdBy, Teamwork
//        users, …) → "Test" / "User-<code>" / "Test User-<code>"; the shared
//        system accounts ("Admin <Org>", "Super User") are kept;
//      - Jenkins causes {userId, userName, shortDescription} → "user-<code>";
//      - structured change-log notes ("Developer: X", "Reviewer: Y", "Dev: X",
//        "Started by user X") → "person-<code>".
//  10. project / tenant / person terms (never committed: the list is a local
//      JSON file named by WI_IMPL_SCRUB_TERMS, see loadScrubTerms) → their
//      placeholders, case-preserving (INITECH → ACME, Initech → Acme);
//  11. real hostnames (URL hosts and `www.` hosts, plus bare hosts with 3+
//      labels) on public TLDs that are not generic infrastructure
//      (GENERIC_HOSTS) → the same host on the reserved `.example` TLD.
//   9. strings that hold JSON (PD `configuration`, AD `jsonDefinition`) are
//      parsed, sanitized recursively and re-stringified — but ONLY when a rule
//      fired inside them; untouched strings stay byte-identical so the
//      round-trip tests still see the real wire bytes.

const SECRET_KEY_RE =
  /^(password|passwd|pwd|secret|client_?secret|api_?key|x-api-key|token|access_?token|refresh_?token|auth_?token|id_?token|session_?token|authorization|cookie|set-cookie|tw-?auth|expertly-auth-token|private_?key)$/i;

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /\b(Bearer|Basic)\s+(?!REDACTED\b)[A-Za-z0-9._~+/=-]{16,}/g;
const COOKIE_RE = /\b(tw-auth|JSESSIONID|SESSION)=(?!REDACTED\b)[^;\s"'&]{8,}/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Needs separators between the groups, so hex ids / timestamps / dates never match.
const PHONE_RE = /(?<![\w.-])(?:\+?1[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w-])/g;

/** Names inside {fieldName,fieldValue} / {name,value} records whose value is sensitive. */
const SECRET_FIELD_NAME_RE =
  /^(password|passwd|pwd|username|user|login|host|hostname|secret|client_?secret|client_?id|api_?key|x-api-key|key|token|access_?token|refresh_?token|auth_?token|authorization|cookie|private_?key|connection_?string|url)$/i;

const SAFE_EMAIL_DOMAINS = /^user\d*@example\.com$|@(example\.(com|org|net)|[a-z0-9-]+\.example)$/i;
const SAFE_PHONE = "555-555-0100";

function isSafeEmail(e: string): boolean {
  return SAFE_EMAIL_DOMAINS.test(e);
}

// ── person names ──────────────────────────────────────────────

/** Short, stable code for a person (FNV-1a over the normalized name, base36). */
export function personCode(name: string): string {
  let h = 0x811c9dc5;
  for (const ch of name.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(4, "0").slice(-4);
}

/** Shared system accounts, not people: kept as-is ("Super User", "Admin <Org>"). */
const SYSTEM_ACCOUNT_RE = /^(super user|admin [a-z0-9]+)$/i;
const PSEUDO_LAST_RE = /^User-[0-9a-z]{4}$/;
const PSEUDO_TEXT_RE = /^(person|user)-[0-9a-z]{4}$/;
const NAME_KEYS = ["firstName", "lastName", "middleName", "fullName", "first-name", "last-name"] as const;

/** Name-note labels in change logs / comments: `Developer: Jane<br>…`, `Reviewer =&gt; X`. */
const NAME_NOTE_RE =
  /\b(Developer|Dev|Reviewer|Reveiwer|Author|Created by|Modified by|Updated by)(\s*(?::|=&gt;|=>)\s*)([A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+)?)/g;
/** Jenkins console: `Started by user <ha:// hyperlink note>name` (the note encodes /user/<name>). */
const STARTED_BY_RE = /Started by user (?:\x1b\[8mha:\/\/\/\/[A-Za-z0-9+/=]+\x1b\[0m)?(?!(?:person|user)-[0-9a-z]{4}\b)([^\s<"\\]+)/g;

function scrubNames(s: string): string {
  return s
    .replace(NAME_NOTE_RE, (_m, label, sep, name) => `${label}${sep}person-${personCode(name)}`)
    .replace(STARTED_BY_RE, (_m, name) => `Started by user user-${personCode(name)}`);
}

/**
 * A person record ({firstName, lastName, fullName, …}): pseudonymize its name
 * fields. Returns the replacement fields, or null when there is nothing to do
 * (no names, a system account, or already pseudonymized).
 */
function personNameFields(obj: Record<string, unknown>): Record<string, string> | null {
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  const first = str("firstName") ?? str("first-name");
  const last = str("lastName") ?? str("last-name");
  const full = str("fullName");
  if (first === undefined && last === undefined && full === undefined) return null;
  const seed = [first, last].filter(Boolean).join(" ").trim() || (full ?? "").trim();
  if (!seed || SYSTEM_ACCOUNT_RE.test(seed)) return null;
  if (last !== undefined && PSEUDO_LAST_RE.test(last)) return null;
  if (last === undefined && full !== undefined && /^Test User-[0-9a-z]{4}$/.test(full)) return null;
  const code = personCode(seed);
  const out: Record<string, string> = {};
  for (const k of NAME_KEYS) {
    const v = str(k);
    if (v === undefined || v === "") continue;
    out[k] = k === "fullName" ? `Test User-${code}` : k === "middleName" ? "" : k.startsWith("first") ? "Test" : `User-${code}`;
  }
  return out;
}

/** Jenkins build cause {userId, userName, shortDescription: "Started by user X"}. */
function jenkinsUserFields(obj: Record<string, unknown>): Record<string, string> | null {
  const id = typeof obj.userId === "string" ? obj.userId : undefined;
  const name = typeof obj.userName === "string" ? obj.userName : undefined;
  if (id === undefined || name === undefined) return null;
  if (PSEUDO_TEXT_RE.test(id) && PSEUDO_TEXT_RE.test(name)) return null;
  const out: Record<string, string> = {
    userId: `user-${personCode(id)}`,
    userName: `user-${personCode(id)}`,
  };
  if (typeof obj.shortDescription === "string") {
    out.shortDescription = obj.shortDescription.split(name).join(out.userName!).split(id).join(out.userId!);
  }
  return out;
}

// ── project terms + hostnames (rules 10, 11) ────────────────────────────────

export type ScrubTerm = [pattern: RegExp, replacement: string];

/**
 * Load the local project-term list: a JSON file `{ "terms": [[regexSource, replacement], …] }`
 * named by WI_IMPL_SCRUB_TERMS (patterns are applied with flags `gi`, in order). The list names
 * real projects and people, so it lives outside the repo; without it only the generic rules run.
 */
export function loadScrubTerms(path: string | undefined = process.env.WI_IMPL_SCRUB_TERMS): ScrubTerm[] {
  if (!path) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { terms?: Array<[string, string]> };
  return (parsed.terms ?? []).map(([source, replacement]) => [new RegExp(source, "gi"), replacement]);
}

let TERMS: ScrubTerm[] = loadScrubTerms();

/** Replace the active term list (tests). */
export function setScrubTerms(terms: ScrubTerm[]): void {
  TERMS = terms;
}

/** The replacement in the case of the match: ALL CAPS, Capitalized, lower — else as given. */
function matchCase(match: string, replacement: string): string {
  if (!/[a-z]/i.test(match)) return replacement;
  if (match === match.toUpperCase()) return replacement.toUpperCase();
  if (match === match.toLowerCase()) return replacement.toLowerCase();
  if (match[0] === match[0]!.toUpperCase() && match.slice(1) === match.slice(1).toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }
  return replacement;
}

export function applyTerms(s: string, terms: ScrubTerm[] = TERMS): string {
  let out = s;
  for (const [re, replacement] of terms) out = out.replace(re, (m) => matchCase(m, replacement));
  return out;
}

/** Public TLDs whose hosts are checked (reserved ones — .test, .example, .invalid, .localhost — never are). */
const PUBLIC_TLD = "(?:com|net|org|io|dev|cloud|app|ai|co|us|in|uk|info|biz|edu|gov|me|xyz|tech|site|online)";
/** Hosts in URLs (`//host`) and `www.` hosts, any label count. */
const URL_HOST_RE = new RegExp(`(?<=//)(?:[a-z0-9-]+\\.)+${PUBLIC_TLD}(?![\\w.-])|\\bwww\\.(?:[a-z0-9-]+\\.)+${PUBLIC_TLD}(?![\\w.-])`, "gi");
/** Bare hosts with 3+ labels (`dev.corp.<tld>`); 2-label words like `ui.info` are code, not hosts. */
const BARE_HOST_RE = new RegExp(`(?<![\\w.@/-])(?:[a-z0-9-]+\\.){2,}${PUBLIC_TLD}(?![\\w.-])`, "gi");

/** Generic infrastructure hosts (exact or a subdomain of) that may stay. */
const GENERIC_HOSTS = [
  "example.com", "example.org", "example.net", "w3.org", "schema.org", "github.com", "githubusercontent.com",
  "bun.sh", "npmjs.com", "npmjs.org", "fonts.googleapis.com", "fonts.gstatic.com", "www.googleapis.com",
  "claude.ai", "claude.com", "anthropic.com", "git-scm.com", "slack.com", "shields.io",
];

function isGenericHost(host: string): boolean {
  const h = host.toLowerCase();
  return GENERIC_HOSTS.some((g) => h === g || h.endsWith(`.${g}`));
}

/** Every non-generic public-TLD host in `text` (URL hosts, www. hosts, bare 3+-label hosts). */
export function findHosts(text: string): string[] {
  const hosts = [...(text.match(URL_HOST_RE) ?? []), ...(text.match(BARE_HOST_RE) ?? [])];
  return [...new Set(hosts.map((h) => h.toLowerCase()))].filter((h) => !isGenericHost(h));
}

function scrubHosts(s: string): string {
  const swap = (h: string) => (isGenericHost(h) ? h : h.replace(/\.[a-z]+$/i, ".example"));
  return s.replace(URL_HOST_RE, swap).replace(BARE_HOST_RE, swap);
}

/** Base64-looking runs (e.g. encoded custom code) that decode to text: never edited token-wise. */
const B64_RUN_RE = /[A-Za-z0-9+/]{16,}={0,2}/g;

function isBase64Text(run: string): boolean {
  if (run.length % 4 !== 0) return false;
  const bytes = Buffer.from(run, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== run) return false;
  let printable = 0;
  for (const b of bytes) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2) printable++;
  return printable / bytes.length >= 0.9;
}

/** `text` with base64-text runs blanked (what rules 10-11 and the tree guard look at). */
export function withoutBase64(text: string): string {
  return text.replace(B64_RUN_RE, (run) => (isBase64Text(run) ? "" : run));
}

/**
 * Rules 10 + 11: plain token swaps, safe inside JSON text (bytes change only at
 * the tokens). Base64 runs are left alone: a swapped letter would corrupt them.
 */
function scrubText(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(B64_RUN_RE)) {
    if (!isBase64Text(m[0])) continue;
    out += scrubHosts(applyTerms(s.slice(last, m.index))) + m[0];
    last = m.index! + m[0].length;
  }
  return out + scrubHosts(applyTerms(s.slice(last)));
}

function scrubString(s: string): string {
  let out = scrubNames(s)
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

interface SanitizeStats {
  redactedKeys: number;
  scrubbedStrings: number;
  reencodedJsonStrings: number;
}

export function sanitize<T>(value: T, stats: SanitizeStats = { redactedKeys: 0, scrubbedStrings: 0, reencodedJsonStrings: 0 }): T {
  return walk(value, stats) as T;
}

function walk(v: unknown, stats: SanitizeStats, textual = true): unknown {
  if (typeof v === "string") {
    const out = sanitizeString(v, stats);
    if (!textual) return out;
    const text = scrubText(out);
    if (text !== out) stats.scrubbedStrings++;
    return text;
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, stats, textual));
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
    const names = personNameFields(obj) ?? jenkinsUserFields(obj);
    for (const [k, val] of Object.entries(obj)) {
      if (names && Object.hasOwn(names, k) && val !== names[k]) {
        out[k] = names[k];
        stats.scrubbedStrings++;
        continue;
      }
      if (redactRecord && k === recValueKey && typeof val === "string" && val !== "" && val !== "REDACTED") {
        out[k] = "REDACTED";
        stats.redactedKeys++;
        continue;
      }
      // Keys can carry PII too (e.g. test data keyed by e-mail address).
      const clean = (x: string) => (textual ? scrubText(scrubString(x)) : scrubString(x));
      let key = clean(k);
      if (key !== k) {
        stats.scrubbedStrings++;
        for (let n = 2; key in out; n++) key = clean(k).replace("user@", `user${n}@`);
      }
      if (SECRET_KEY_RE.test(k) && typeof val === "string" && val !== "" && val !== "REDACTED") {
        out[key] = "REDACTED";
        stats.redactedKeys++;
      } else {
        out[key] = walk(val, stats, textual);
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
      // Secret/PII rules only: rules 10-11 run on the text afterwards (keeps the bytes).
      const cleaned = walk(parsed, inner, false);
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
  return scrubText(scrubString(s));
}

interface SecretFinding {
  kind: "jwt" | "bearer" | "cookie" | "email" | "phone" | "secret-key" | "person-name";
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
  // Person names: name fields must be pseudonyms, empty, or a system account part.
  const allowedNamePart = /^(|Test|Admin|Super|User|[A-Z][A-Z0-9]+|Admin [A-Za-z0-9]+|Super User|User-[0-9a-z]{4}|Test User-[0-9a-z]{4})$/;
  const nameRe = /\\?"(firstName|lastName|middleName|fullName|first-name|last-name)\\?"\s*:\s*\\?"([^"\\]*)/g;
  for (const m of text.matchAll(nameRe)) {
    if (!allowedNamePart.test(m[2]!)) found.push({ kind: "person-name", match: `${m[1]}=${m[2]!.slice(0, 3)}…` });
  }
  const jenkinsRe = /\\?"(userId|userName)\\?"\s*:\s*\\?"([^"\\]*)/g;
  for (const m of text.matchAll(jenkinsRe)) {
    if (!/^user-[0-9a-z]{4}$/.test(m[2]!)) found.push({ kind: "person-name", match: `${m[1]}=${m[2]!.slice(0, 3)}…` });
  }
  for (const m of text.matchAll(NAME_NOTE_RE)) found.push({ kind: "person-name", match: `${m[1]}: ${m[3]!.slice(0, 3)}…` });
  for (const m of text.matchAll(STARTED_BY_RE)) found.push({ kind: "person-name", match: `Started by user ${m[1]!.slice(0, 3)}…` });
  return found;
}
