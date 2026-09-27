// SpEL `#{…}` scanning for the validator.
//
// AD evaluates `#{…}` blocks inside step-input values, conditions, loop sources,
// SQL text and custom-code source. When a block is malformed the platform does
// not fail the save: the literal text flows on to later steps (research §4.2,
// cases v2_spel_*). This module finds the blocks, the malformed ones, and the
// root identifiers a block reads, for the reference graph (graph.ts).

export interface SpelBlock {
  /** Index of `#` in the source. */
  start: number;
  /** Index just past the closing `}`. */
  end: number;
  /** Text between `#{` and the matching `}`. */
  body: string;
}

export type SpelIssueKind = "unclosed" | "nested" | "hashVar" | "braceLiteral" | "syntax";

export interface SpelIssue {
  kind: SpelIssueKind;
  /** The offending block text (or the tail after an unclosed `#{`). */
  text: string;
  detail?: string;
}

export interface SpelScan {
  blocks: SpelBlock[];
  issues: SpelIssue[];
}

export function hasSpel(text: unknown): text is string {
  return typeof text === "string" && text.includes("#{");
}

/**
 * Find every top-level `#{…}` block. Braces are counted (a map literal inside
 * a block does not close it) and quoted text is skipped, so `#{'}'}` is one
 * block. A `#{` inside an open block is reported as nesting (not supported).
 */
export function scanSpel(text: string): SpelScan {
  const blocks: SpelBlock[] = [];
  const issues: SpelIssue[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("#{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 2;
    let quote: string | null = null;
    let nested = false;
    for (; j < text.length && depth > 0; j++) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') quote = c;
      else if (c === "#" && text[j + 1] === "{") nested = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth > 0) {
      issues.push({ kind: "unclosed", text: text.slice(open, open + 60) });
      break;
    }
    const body = text.slice(open + 2, j - 1);
    const block: SpelBlock = { start: open, end: j, body };
    blocks.push(block);
    const whole = text.slice(open, j);
    if (nested) issues.push({ kind: "nested", text: whole });
    else {
      const t = body.trim();
      if (t.startsWith("#")) issues.push({ kind: "hashVar", text: whole });
      else if (t.startsWith("{")) issues.push({ kind: "braceLiteral", text: whole });
      else {
        const detail = syntaxProblem(t);
        if (detail) issues.push({ kind: "syntax", text: whole, detail });
      }
    }
    i = j;
  }
  return { blocks, issues };
}

const TRAILING_OPERATOR_RE =
  /(?:[+\-*/%^<>=!?:,(.]|&&|\|\||\b(?:and|or|not|eq|ne|lt|gt|le|ge|div|mod|instanceof|matches|between))$/i;
const LEADING_OPERATOR_RE = /^(?:[*/%^=,)]|&&|\|\||\b(?:and|or|eq|ne|lt|gt|le|ge|div|mod)\b)/i;

/** Cheap structural lint of one block body (not a full SpEL parser). */
export function syntaxProblem(body: string): string | undefined {
  if (!body) return "empty expression";
  const stripped = stripStrings(body);
  if (stripped === null) return "unterminated string literal";
  let paren = 0;
  let bracket = 0;
  for (const c of stripped) {
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "[") bracket++;
    else if (c === "]") bracket--;
    if (paren < 0 || bracket < 0) return "unbalanced brackets";
  }
  if (paren !== 0 || bracket !== 0) return "unbalanced brackets";
  const t = stripped.trim();
  if (TRAILING_OPERATOR_RE.test(t)) return "expression ends with an operator";
  if (LEADING_OPERATOR_RE.test(t)) return "expression starts with an operator";
  return undefined;
}

/** Replace quoted literals with `''`; null when a quote is unterminated. */
export function stripStrings(body: string): string | null {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === quote) {
        // SpEL escapes a quote by doubling it: 'it''s'
        if (body[i + 1] === quote) {
          i++;
          continue;
        }
        quote = null;
        out += "''";
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    out += c;
  }
  return quote ? null : out;
}

const KEYWORDS = new Set([
  "and", "or", "not", "eq", "ne", "lt", "gt", "le", "ge", "div", "mod",
  "null", "true", "false", "instanceof", "matches", "between", "new", "T",
]);

/**
 * Identifiers a block reads from the evaluation context: the first name of
 * every property path that is not a member access (`.x`), a SpEL variable
 * (`#x`), a bean (`@x`), a type (`T(…)`, `new a.b.C`), or inside a
 * selection/projection (`?[…]`, `![…]`, whose names are element properties).
 */
export function spelRoots(body: string): string[] {
  const s = stripStrings(body);
  if (s === null) return [];
  let src = removeTypeRefs(s);
  src = removeSelections(src);
  const roots = new Set<string>();
  const re = /[A-Za-z_$][\w$]*/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const name = m[0];
    const before = src.slice(0, m.index).replace(/\s+$/, "");
    const prev = before[before.length - 1];
    if (prev === "." || prev === "#" || prev === "@" || prev === "$") continue;
    if (/\bnew$/.test(before)) continue;
    // a number like 1e5 or 0x1F
    if (/[0-9]$/.test(src.slice(0, m.index))) continue;
    if (KEYWORDS.has(name) || KEYWORDS.has(name.toLowerCase())) continue;
    roots.add(name);
  }
  return [...roots];
}

function removeTypeRefs(src: string): string {
  let out = src;
  // T(java.lang.Integer) → T()
  for (;;) {
    const m = /\bT\s*\(/.exec(out);
    if (!m) break;
    const openIdx = m.index + m[0].length - 1;
    const close = matching(out, openIdx, "(", ")");
    if (close < 0) break;
    out = out.slice(0, m.index) + "0" + out.slice(close + 1);
  }
  // new java.util.Date() → new 0()
  out = out.replace(/\bnew\s+[A-Za-z_$][\w$.]*/g, "0");
  return out;
}

function removeSelections(src: string): string {
  let out = src;
  for (;;) {
    const m = /[?!^$]\[/.exec(out);
    if (!m) break;
    const openIdx = m.index + 1;
    const close = matching(out, openIdx, "[", "]");
    if (close < 0) break;
    out = out.slice(0, m.index) + out.slice(close + 1);
  }
  return out;
}

function matching(s: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Replace every `#{…}` block with a JS identifier, for the custom-code parse check. */
export function replaceSpelBlocks(text: string, placeholder: string): string {
  const { blocks } = scanSpel(text);
  if (blocks.length === 0) return text;
  let out = "";
  let last = 0;
  for (const b of blocks) {
    out += text.slice(last, b.start) + placeholder;
    last = b.end;
  }
  return out + text.slice(last);
}
