// Fuzzy text scoring shared by the AD method finder and the PD page finder,
// plus the edit distance the arg parser uses for "did you mean" hints.

/** Lower-cased, trimmed query/value form every scorer compares. */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * Score `value` against an already-normalized `query`: exact 1000, prefix 900,
 * word start 850, substring 760, else a fuzzy score (subsequence or a close
 * token). The result is scaled by `weight`; 0 means no match.
 */
export function scoreText(query: string, value: string, weight: number): number {
  const normalizedValue = normalizeSearchText(value);
  if (!normalizedValue) return 0;

  let base = 0;
  if (normalizedValue === query) {
    base = 1000;
  } else if (normalizedValue.startsWith(query)) {
    base = 900;
  } else if (containsWordStart(normalizedValue, query)) {
    base = 850;
  } else if (normalizedValue.includes(query)) {
    base = 760;
  } else {
    base = fuzzyScore(query, normalizedValue);
  }

  if (base <= 0) return 0;
  return Math.max(1, Math.round(base * weight));
}

/** `query` starts `value` or one of its words (after space . _ - /). */
export function containsWordStart(value: string, query: string): boolean {
  if (value.startsWith(query)) return true;
  return value.includes(` ${query}`)
    || value.includes(`.${query}`)
    || value.includes(`_${query}`)
    || value.includes(`-${query}`)
    || value.includes(`/${query}`);
}

function fuzzyScore(query: string, value: string): number {
  const q = query.trim();
  if (!q) return 0;

  let best = subsequenceScore(q, value);

  const maxDistance = Math.max(1, Math.floor(q.length * 0.4));
  for (const token of tokenize(value)) {
    if (token.length < 2) continue;
    if (Math.abs(token.length - q.length) > maxDistance + 4) continue;

    const distance = levenshtein(q, token);
    if (distance > maxDistance) continue;

    const score = 640 - distance * 120 - Math.abs(token.length - q.length) * 12;
    best = Math.max(best, score);
  }

  return Math.max(0, best);
}

function subsequenceScore(query: string, value: string): number {
  let qIndex = 0;
  let vIndex = 0;
  while (qIndex < query.length && vIndex < value.length) {
    if (query[qIndex] === value[vIndex]) qIndex += 1;
    vIndex += 1;
  }
  if (qIndex < query.length) return 0;

  const density = query.length / Math.max(1, value.length);
  const lengthBoost = Math.min(1, query.length / 8);
  return Math.round(420 + density * 180 + lengthBoost * 40);
}

/** Lower-case alphanumeric runs of an already-normalized value. */
export function tokenize(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/g)
    .map(t => t.trim())
    .filter(Boolean);
}

/** Levenshtein edit distance (two-row DP). */
export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // Indices are always in bounds.
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Last item wins per key, in first-seen key order. */
export function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(keyFn(item), item);
  return [...map.values()];
}
