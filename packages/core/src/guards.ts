// Value guards for untyped wire JSON. Shared by every integration so each
// module stops re-declaring its own `isObj` / `str` / `num`.

export type Obj = Record<string, unknown>;

/** A plain object (not null, not an array). */
export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `v` as a plain object, or null. */
export function asObj(v: unknown): Obj | null {
  return isObj(v) ? v : null;
}

/** A non-blank string, trimmed; otherwise undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** A non-blank string, trimmed; otherwise null. */
export function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A finite number; otherwise null. */
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A finite number, or a non-blank string that parses as one; otherwise null. */
export function numLike(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
