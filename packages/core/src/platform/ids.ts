// Expertly entity ids (AD method uuids, PD page/component ids) and their
// normalisation.
//
// The platform hands out uuids in several spellings: 32 hex characters padded
// with 4 trailing spaces (most V1/V2 records), dashed 36-character uuids
// (db_service and a few system services), mixed case when copied from logs,
// and whole AD editor URLs pasted by users. Every AD command that takes a
// method uuid must go through `resolveMethodRef`, so the path it builds, the
// cache key it uses and the value it echoes back are the same canonical form.

import { CliError } from "../command";

/** 32 hex characters (the AD/PD id form), any case. */
const HEX32_RE = /^[0-9a-f]{32}$/i;
/** A dashed 36-character uuid, any case. */
const DASHED_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exactly 32 hex characters (no trimming). */
export function isHex32(s: string): boolean {
  return HEX32_RE.test(s);
}

/** A 32-hex or dashed uuid (no trimming). */
export function isEntityId(s: string): boolean {
  return HEX32_RE.test(s) || DASHED_UUID_RE.test(s);
}

/** Lower-case, dashes removed (for comparing ids spelled differently). */
export function canonicalUuid(s: string): string {
  return s.replace(/-/g, "").toLowerCase();
}

/**
 * Canonical method uuid: trimmed, lower-case, 32 hex characters, no dashes.
 *
 * Accepts:
 *   - `4bf56e008eabe4010508af439a15ecfb` (as-is)
 *   - `"4bf56e008eabe4010508af439a15ecfb    "` (padded, as the wire returns it)
 *   - `4BF56E00…` (upper case)
 *   - `4bf56e00-8eab-e401-0508-af439a15ecfb` (dashed)
 *   - `https://dev.example.test/automation-designer/Sandbox/4bf56e00…` (AD URL, query/hash ignored)
 *
 * Anything else throws `CliError` with code `INVALID_UUID`.
 */
export function resolveMethodRef(input: string): string {
  const raw = typeof input === "string" ? input.trim() : "";
  const candidate = looksLikeUrl(raw) ? lastUrlSegment(raw) : raw;
  const lowered = candidate.toLowerCase();
  if (HEX32_RE.test(lowered)) return lowered;
  if (DASHED_UUID_RE.test(lowered)) return lowered.replace(/-/g, "");
  throw new CliError(
    `Not a method uuid or AD URL: '${raw}'. Expected 32 hex characters (dashes and surrounding spaces are ignored) ` +
      "or an Automation Designer URL ending in the uuid.",
    { code: "INVALID_UUID", details: { input: raw } },
  );
}

/**
 * Trim a uuid the server padded with spaces. Keeps case and dashes (dashed
 * service uuids are compared as the server spells them). Empty → null.
 */
export function normalizeUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/**
 * Deep copy with the server's space padding trimmed from every uuid-shaped
 * string (`"4a1b…    "` → `"4a1b…"`; smoke --llm envelope #8). Other strings
 * are left exactly as they are.
 */
export function trimUuidPadding<T>(value: T): T {
  if (typeof value === "string") {
    return (/^[0-9a-f]{32}\s+$/i.test(value) ? value.trim() : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => trimUuidPadding(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = trimUuidPadding(v);
    return out as T;
  }
  return value;
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /\/automation-designer\//i.test(s);
}

function lastUrlSegment(s: string): string {
  let path = s;
  try {
    path = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).pathname;
  } catch {
    path = s.split(/[?#]/)[0] ?? s;
  }
  const segments = path.split("/").map((p) => decodeURIComponentSafe(p).trim()).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
