// A small line diff for `ad history diff`: which lines of a step's SQL / code / SpEL changed
// between two versions, as unified-diff hunks (`@@ -a,n +b,m @@`, ` ctx`, `-old`, `+new`).
// Common leading / trailing lines are trimmed first, so the LCS only runs over the changed
// middle; a middle too large for it is reported as one replaced block.

/** LCS cells above this fall back to "the whole middle was replaced". */
const MAX_CELLS = 4_000_000;

type Op = { t: " " | "-" | "+"; line: string };

function lcsOps(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_CELLS) return [...a.map((line) => ({ t: "-" as const, line })), ...b.map((line) => ({ t: "+" as const, line }))];
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..], one flat row-major array
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j]! >= dp[i * (m + 1) + j + 1]!) ops.push({ t: "-", line: a[i++]! });
    else ops.push({ t: "+", line: b[j++]! });
  }
  while (i < n) ops.push({ t: "-", line: a[i++]! });
  while (j < m) ops.push({ t: "+", line: b[j++]! });
  return ops;
}

/** Unified-diff hunks from `before` to `after` (`context` unchanged lines around each change); [] when equal. */
export function lineDiff(before: string, after: string, context = 2): string[] {
  if (before === after) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: Op[] = [
    ...a.slice(0, head).map((line) => ({ t: " " as const, line })),
    ...lcsOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((line) => ({ t: " " as const, line })),
  ];

  // Group changes (with `context` lines around them) into hunks.
  const out: string[] = [];
  let k = 0;
  let aLine = 1;
  let bLine = 1;
  const pos: Array<{ a: number; b: number }> = ops.map((op) => {
    const p = { a: aLine, b: bLine };
    if (op.t !== "+") aLine++;
    if (op.t !== "-") bLine++;
    return p;
  });
  while (k < ops.length) {
    if (ops[k]!.t === " ") {
      k++;
      continue;
    }
    let start = Math.max(0, k - context);
    let end = k;
    // extend while the next change is within 2 * context unchanged lines
    for (;;) {
      while (end < ops.length && ops[end]!.t !== " ") end++;
      let gap = end;
      while (gap < ops.length && ops[gap]!.t === " " && gap - end < 2 * context) gap++;
      if (gap < ops.length && ops[gap]!.t !== " ") end = gap;
      else break;
    }
    const stop = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, stop);
    const aCount = hunk.filter((o) => o.t !== "+").length;
    const bCount = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${pos[start]!.a},${aCount} +${pos[start]!.b},${bCount} @@`);
    for (const o of hunk) out.push(`${o.t}${o.line}`);
    k = stop;
    start = stop;
  }
  return out;
}
