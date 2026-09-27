// Identifier normalisation for AD (AD-30, F11, AD-09).
//
// The platform hands out uuids in several spellings: 32 hex characters padded
// with 4 trailing spaces (most V1/V2 records), dashed 36-character uuids
// (db_service and a few system services), mixed case when copied from logs,
// and whole AD editor URLs pasted by users. Every AD command that takes a
// method uuid must go through `resolveMethodRef`, so the path it builds, the
// cache key it uses and the value it echoes back are the same canonical form.

import { CliError } from "@belzabar/core";

const HEX32 = /^[0-9a-f]{32}$/;
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Canonical method uuid: trimmed, lower-case, 32 hex characters, no dashes.
 *
 * Accepts:
 *   - `4bf56e008eabe4010508af439a15ecfb` (as-is)
 *   - `"4bf56e008eabe4010508af439a15ecfb    "` (padded, as the wire returns it)
 *   - `4BF56E00…` (upper case)
 *   - `4bf56e00-8eab-e401-0508-af439a15ecfb` (dashed)
 *   - `https://sems-dev…/automation-designer/Test-Parth/4bf56e00…` (AD URL, query/hash ignored)
 *
 * Anything else throws `CliError` with code `INVALID_UUID`.
 */
export function resolveMethodRef(input: string): string {
  const raw = typeof input === "string" ? input.trim() : "";
  const candidate = looksLikeUrl(raw) ? lastUrlSegment(raw) : raw;
  const lowered = candidate.toLowerCase();
  if (HEX32.test(lowered)) return lowered;
  if (DASHED.test(lowered)) return lowered.replace(/-/g, "");
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
