// Dot-notation key paths (`layout.children[1].props.innerHTML`) and the PD
// partial-update value encoding, shared by applyOverlay (in-memory edit) and
// the partial-ops serializer, so both agree on what an operation does.

import type { PartialDataType } from "../types/common";

type PathSegment = string | number;

/**
 * `a.b[2].c` → ["a", "b", 2, "c"]. A dot-segment that is not `name[0][1]…`
 * is a literal key, so Angular-style prop keys work:
 * `props.[innerHTML]` → ["props", "[innerHTML]"], `field.[(value)]` → ["field", "[(value)]"].
 */
export function parsePath(key: string): PathSegment[] {
  const out: PathSegment[] = [];
  for (const part of key.split(".")) {
    if (part === "") continue;
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) {
      out.push(part);
      continue;
    }
    if (m[1]) out.push(m[1]);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

/**
 * Partial-op key shapes the server is KNOWN to parse (verified live
 * 2026-09-29 on a scratch page; wire evidence in
 * tests/fixtures/wire/partial-keys.json). The server splits the key on EVERY
 * `.`, reads a trailing `[n]` run as array indices, and takes any other
 * segment as a literal property name:
 *   - plain names, with `[n]` indices: `className`, `children[1]`, `data-x`,
 *     `my key`, `2col`, `(click)` (an event-binding prop);
 *   - bracketed binding props as one literal key: `[innerHTML]`, `[(value)]`,
 *     `[student-id]`, and `name[non-digit]` (`foo[bar]`) — the same way
 *     wi-impl's `parsePath` reads them.
 * NOT sendable: a key whose property name itself contains a `.` (Angular
 * `[attr.title]`, `[class.x]`): the server splits it, the half-bracketed
 * segments answer HTTP 500 and nothing is stored. Those edits are full saves.
 * (A missing parent object is not a shape problem: the server answers 200
 * and silently stores nothing, so planSave's replay check already makes such
 * an edit a full save.)
 */
const PLAIN_SEGMENT = /^[^.[\]]+(?:\[\d+\])*$/;
const BINDING_SEGMENT = /^[^.[\]]*\[[^.[\]]*[^.[\]\d][^.[\]]*\]$/;

/** True when every dot segment of `key` is a verified shape (see PLAIN_SEGMENT / BINDING_SEGMENT). */
export function isVerifiedKeyShape(key: string): boolean {
  const parts = key.split(".");
  return parts.length > 0 && parts.every((p) => PLAIN_SEGMENT.test(p) || BINDING_SEGMENT.test(p));
}

type Container = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Container {
  return !!v && typeof v === "object";
}

/** The parent container of `key` and the last segment, or null when the parent does not exist. */
function resolveParent(root: unknown, key: string): { parent: Container; last: PathSegment } | null {
  const path = parsePath(key);
  if (path.length === 0) return null;
  let cur: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    if (!isContainer(cur)) return null;
    if (typeof seg === "number" && !Array.isArray(cur)) return null;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  if (!isContainer(cur)) return null;
  const last = path[path.length - 1]!;
  if (typeof last === "number" && !Array.isArray(cur)) return null;
  return { parent: cur, last };
}

/** True when `key` exists (its parent exists and has the property/index). */
export function hasPath(root: unknown, key: string): boolean {
  const r = resolveParent(root, key);
  if (!r) return false;
  if (Array.isArray(r.parent)) return typeof r.last === "number" && r.last < r.parent.length;
  return Object.prototype.hasOwnProperty.call(r.parent, r.last);
}

/** Set `key` to `value`. Returns false when the parent path does not resolve. */
export function setPath(root: unknown, key: string, value: unknown): boolean {
  const r = resolveParent(root, key);
  if (!r) return false;
  (r.parent as Record<string | number, unknown>)[r.last] = value;
  return true;
}

// -------- value encoding (PD partial update: value is ALWAYS a string) ----

export function guessDataType(value: unknown): PartialDataType {
  if (Array.isArray(value)) return "ARRAY";
  if (value === null) return "OBJECT";
  const t = typeof value;
  if (t === "string") return "STRING";
  if (t === "number") return "NUMBER";
  if (t === "boolean") return "BOOLEAN";
  return "OBJECT";
}

export function encodeValue(value: unknown, dataType: PartialDataType): string {
  if (dataType === "STRING") return typeof value === "string" ? value : String(value);
  if (dataType === "NUMBER") {
    if (typeof value === "number") return String(value);
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return value;
    return String(Number(value));
  }
  if (dataType === "BOOLEAN") return value === true || value === "true" ? "true" : "false";
  // ARRAY / OBJECT: a string is taken as already-encoded JSON.
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value ?? null);
}

/** What the server stores for an encoded value (inverse of encodeValue). */
export function decodeValue(value: string, dataType: PartialDataType): unknown {
  switch (dataType) {
    case "STRING":
      return value;
    case "NUMBER":
      return Number(value);
    case "BOOLEAN":
      return value === "true";
    default:
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
  }
}
