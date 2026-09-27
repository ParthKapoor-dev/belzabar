// JSON path diff helpers shared by the V2 save pipeline (L0 checks, the
// freshness re-GET and the post-save verify).
//
// Paths look like `steps[2].properties.customCode.inlineCode`: object keys
// joined with `.`, array indexes in `[i]`, the root is `$`.

/** `p` equals `prefix` or lies below it (`prefix.x` / `prefix[i]`). */
export function isUnder(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`);
}

/**
 * Deep-diff two parsed JSON values and return the paths of every differing
 * leaf (or of a subtree that was added/removed/changed type). Object key
 * order is ignored; array order is significant.
 */
export function diffPaths(a: unknown, b: unknown, path = ""): string[] {
  if (a === b) return [];
  const aObj = a !== null && typeof a === "object";
  const bObj = b !== null && typeof b === "object";
  if (!aObj || !bObj || Array.isArray(a) !== Array.isArray(b)) return [path || "$"];
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length || i >= b.length) out.push(p);
      else out.push(...diffPaths(a[i], b[i], p));
    }
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const out: string[] = [];
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in ao) || !(k in bo)) out.push(p);
    else out.push(...diffPaths(ao[k], bo[k], p));
  }
  return out;
}

/** Split a path produced by {@link diffPaths} into keys / indexes. */
export function pathSegments(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) out.push(m[2] !== undefined ? Number(m[2]) : m[1]!);
  return out;
}

/** Value at `path`, or `undefined` when any segment is missing. */
export function getAtPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of pathSegments(path)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** Structural JSON equality (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return diffPaths(a, b).length === 0;
}
