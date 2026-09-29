// Output expectations for `ad test --expect` and test-case assertions.
//
//   out=val     equal            out!=val   not equal
//   out~=val    contains         out>val  out<val  out>=val  out<=val   numeric
//   out.a[0].b=val               path into an output that holds JSON
//
// The right-hand side is JSON when it parses (42, true, null, {"a":1}),
// else a plain string; quote it ('42' or "42") to force a string. Equality is
// forgiving about the wire: every test output arrives as text, so "42" equals
// 42 and a JSON string equals the parsed value.
//
// Test-case assertions are stored as advance-mode SpEL
// (`#{out} eq 'value'`, the AD UI encoding — api-endpoints.md §8.5), so the
// same syntax converts to and from an assertion (eq/neq/gt/lt/contains only,
// no path: those are the operators the UI understands).

import { CliError } from "@belzabar/core";

type ExpectOp = "eq" | "neq" | "contains" | "gt" | "lt" | "ge" | "le";

export interface Expectation {
  /** The text as given (`greetingOut=Hello`). */
  source: string;
  output: string;
  /** Path below the output value (`["a", 0, "b"]`); empty for the whole output. */
  path: Array<string | number>;
  op: ExpectOp;
  expected: unknown;
  /** Right-hand side as typed (quotes stripped). */
  text: string;
  /** The value was quoted: compare as a string. */
  quoted: boolean;
}

export interface ExpectationResult {
  expectation: string;
  output: string;
  op: ExpectOp;
  expected: unknown;
  actual: unknown;
  pass: boolean;
  reason?: string;
}

const OPS: Array<[string, ExpectOp]> = [
  ["!=", "neq"],
  ["~=", "contains"],
  [">=", "ge"],
  ["<=", "le"],
  ["=", "eq"],
  [">", "gt"],
  ["<", "lt"],
];

const OP_SYMBOL: Record<ExpectOp, string> = { eq: "=", neq: "!=", contains: "~=", gt: ">", lt: "<", ge: ">=", le: "<=" };

const LHS_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_$-]+|\[\d+\])*)\s*/;

function invalid(source: string, why: string, code = "INVALID_EXPECTATION"): CliError {
  // A persisted assertion (`test-case --assert`) is the UI's SpEL: whole outputs only,
  // so it must not suggest `out.path` (the hint contradicted the error).
  const hint =
    code === "INVALID_ASSERTION"
      ? "Use out=value, out!=value, out~=value, out>n, out<n on a whole output (to look inside a JSON output, use `belz ad test --expect out.path[0]=value`, which is checked locally)."
      : "Use out=value, out!=value, out~=value, out>n, out<n (out.path[0]=value for JSON outputs).";
  const label = code === "INVALID_ASSERTION" ? "assertion" : "expectation";
  return new CliError(`Invalid ${label} '${source}': ${why}. ${hint}`, { code });
}

/** Parse the right-hand side: quoted → string; JSON → value; else the text. */
function parseLiteral(raw: string): { value: unknown; text: string; quoted: boolean } {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    const inner = t.slice(1, -1);
    return { value: inner, text: inner, quoted: true };
  }
  if (t === "") return { value: "", text: "", quoted: false };
  try {
    return { value: JSON.parse(t), text: t, quoted: false };
  } catch {
    return { value: t, text: t, quoted: false };
  }
}

export function parseExpectation(source: string): Expectation {
  const m = LHS_RE.exec(source);
  if (!m) throw invalid(source, "it must start with an output key");
  const rest = source.slice(m[0].length);
  const hit = OPS.find(([sym]) => rest.startsWith(sym));
  if (!hit) throw invalid(source, "no operator after the output key");
  const [sym, op] = hit;
  const lit = parseLiteral(rest.slice(sym.length));
  const path: Array<string | number> = [];
  for (const seg of m[2]!.match(/\.[A-Za-z0-9_$-]+|\[\d+\]/g) ?? []) {
    path.push(seg.startsWith("[") ? Number(seg.slice(1, -1)) : seg.slice(1));
  }
  if ((op === "gt" || op === "lt" || op === "ge" || op === "le") && !Number.isFinite(Number(lit.text))) {
    throw invalid(source, `${sym} needs a number`);
  }
  return { source, output: m[1]!, path, op, expected: lit.value, text: lit.text, quoted: lit.quoted };
}

function pathText(path: Array<string | number>): string {
  return path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("");
}

function formatExpectation(e: Pick<Expectation, "output" | "path" | "op" | "expected">): string {
  const path = pathText(e.path);
  const rhs = typeof e.expected === "string" ? e.expected : JSON.stringify(e.expected);
  return `${e.output}${path}${OP_SYMBOL[e.op]}${rhs}`;
}

// ── evaluation ────────────────────────────────────────────────────────────

function tryJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/** Wire-tolerant equality: exact, text form, or the JSON a string output holds. */
function looseEqual(actual: unknown, e: Pick<Expectation, "expected" | "text" | "quoted">): boolean {
  if (e.quoted) return isScalar(actual) && actual !== null && String(actual) === e.text;
  if (deepEqual(actual, e.expected)) return true;
  if (actual === undefined) return false;
  if (isScalar(actual) && actual !== null && String(actual) === e.text) return true;
  if (e.expected === null) return actual === null || (typeof actual === "string" && actual.trim() === "null");
  return typeof actual === "string" && deepEqual(tryJson(actual), e.expected);
}

function descend(value: unknown, path: Array<string | number>): { found: boolean; value: unknown } {
  let cur = value;
  for (const seg of path) {
    cur = tryJson(cur);
    if (cur === null || typeof cur !== "object") return { found: false, value: undefined };
    const next = (cur as Record<string | number, unknown>)[seg];
    if (next === undefined) return { found: false, value: undefined };
    cur = next;
  }
  return { found: true, value: cur };
}

function contains(actual: unknown, e: Expectation): boolean {
  const v = tryJson(actual);
  if (Array.isArray(v)) return v.some((x) => looseEqual(x, e));
  if (typeof actual === "string") return actual.includes(e.text);
  if (v && typeof v === "object") return Object.prototype.hasOwnProperty.call(v, e.text) || JSON.stringify(v).includes(e.text);
  return actual !== undefined && actual !== null && String(actual).includes(e.text);
}

/** Evaluate one expectation against a test run's method outputs (`{code: value}`). */
export function evaluateExpectation(outputs: Record<string, unknown>, e: Expectation): ExpectationResult {
  const base = { expectation: e.source, output: e.output, op: e.op, expected: e.expected };
  if (!Object.prototype.hasOwnProperty.call(outputs, e.output)) {
    const known = Object.keys(outputs);
    return { ...base, actual: undefined, pass: false, reason: `output '${e.output}' is not in the result (${known.length ? known.join(", ") : "no outputs"})` };
  }
  const hit = descend(outputs[e.output], e.path);
  if (!hit.found) {
    return { ...base, actual: undefined, pass: false, reason: `path ${pathText(e.path)} not found in '${e.output}'` };
  }
  const actual = hit.value;
  let pass: boolean;
  let reason: string | undefined;
  switch (e.op) {
    case "eq":
      pass = looseEqual(actual, e);
      break;
    case "neq":
      pass = !looseEqual(actual, e);
      break;
    case "contains":
      pass = contains(actual, e);
      break;
    default: {
      const a = Number(typeof actual === "string" ? actual.trim() : actual);
      const b = Number(e.text);
      if (actual === null || actual === "" || !Number.isFinite(a)) {
        pass = false;
        reason = "actual value is not a number";
      } else {
        pass = e.op === "gt" ? a > b : e.op === "lt" ? a < b : e.op === "ge" ? a >= b : a <= b;
      }
    }
  }
  const out: ExpectationResult = { ...base, actual, pass };
  if (!pass) out.reason = reason ?? `expected ${e.op} ${JSON.stringify(e.expected)}, got ${JSON.stringify(actual)}`;
  return out;
}

export function evaluateExpectations(outputs: Record<string, unknown>, list: Expectation[]): ExpectationResult[] {
  return list.map((e) => evaluateExpectation(outputs, e));
}

// ── test-case assertions (advance-mode SpEL) ──────────────────────────────

const ASSERT_OPS = ["eq", "neq", "gt", "lt", "contains"] as const;
type AssertOp = (typeof ASSERT_OPS)[number];

/** A test-case assertion in the git-friendly case-file form. */
interface StructuredAssertion {
  output: string;
  op: AssertOp;
  expected: string | number | boolean | null;
}

/** An assertion belz cannot read back structurally: kept verbatim. */
interface RawAssertion {
  expression: string | null;
  mode?: string;
  conditions?: unknown;
}

export type CaseAssertion = StructuredAssertion | RawAssertion;

export function isStructured(a: CaseAssertion): a is StructuredAssertion {
  return typeof (a as StructuredAssertion).output === "string";
}

/** `--assert out=value` → a structured assertion (UI operators, no path, scalar value). */
export function assertionFromExpectation(e: Expectation): StructuredAssertion {
  const code = "INVALID_ASSERTION";
  if (e.path.length > 0) throw invalid(e.source, "assertions compare a whole output (no .path)", code);
  if (!(ASSERT_OPS as readonly string[]).includes(e.op)) {
    throw invalid(e.source, `the AD UI only evaluates ${ASSERT_OPS.join(", ")} (=, !=, >, <, ~=)`, code);
  }
  const v = e.expected;
  if (v !== null && typeof v === "object") throw invalid(e.source, "assertion values must be a string, number, boolean or null", code);
  return { output: e.output, op: e.op as AssertOp, expected: v as StructuredAssertion["expected"] };
}

/** SpEL literal: strings single-quoted ('' escapes), numbers/booleans/null bare. */
function spelLiteral(v: StructuredAssertion["expected"]): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

export function assertionExpression(a: StructuredAssertion): string {
  return `#{${a.output}} ${a.op} ${spelLiteral(a.expected)}`;
}

/** The UI wire shape of one assertion. */
export function assertionToWire(a: CaseAssertion): Record<string, unknown> {
  if (isStructured(a)) return { mode: "advance", conditionExpression: assertionExpression(a), conditions: null };
  const out: Record<string, unknown> = { mode: a.mode ?? "advance", conditionExpression: a.expression };
  out.conditions = a.conditions === undefined ? null : typeof a.conditions === "string" || a.conditions === null ? a.conditions : JSON.stringify(a.conditions);
  return out;
}

const ASSERT_RE = /^\s*#\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\s+(eq|neq|gt|lt|contains)\s+(.+?)\s*$/;

/** Read a stored assertion back: structured when it is `#{out} op literal`, else raw. */
export function assertionFromWire(w: Record<string, unknown>): CaseAssertion {
  const expr = typeof w.conditionExpression === "string" ? w.conditionExpression : null;
  const mode = typeof w.mode === "string" ? w.mode : undefined;
  const m = expr && (mode === undefined || mode === "advance") && !w.conditions ? ASSERT_RE.exec(expr) : null;
  if (m) {
    const lit = m[3]!;
    let expected: StructuredAssertion["expected"] | undefined;
    const q = /^'((?:[^']|'')*)'$/.exec(lit);
    if (q) expected = q[1]!.replace(/''/g, "'");
    else if (lit === "null") expected = null;
    else if (lit === "true" || lit === "false") expected = lit === "true";
    else if (/^-?\d+(\.\d+)?$/.test(lit)) expected = Number(lit);
    if (expected !== undefined) return { output: m[1]!, op: m[2] as AssertOp, expected };
  }
  const raw: RawAssertion = { expression: expr };
  if (mode !== undefined && mode !== "advance") raw.mode = mode;
  if (w.conditions !== undefined && w.conditions !== null) raw.conditions = tryJson(w.conditions);
  return raw;
}

/** A structured assertion as an expectation, so `ad test --case` can evaluate it locally. */
export function expectationFromAssertion(a: StructuredAssertion): Expectation {
  const text = a.expected === null ? "null" : String(a.expected);
  return {
    source: formatExpectation({ output: a.output, path: [], op: a.op, expected: a.expected }),
    output: a.output,
    path: [],
    op: a.op,
    expected: a.expected,
    text,
    quoted: typeof a.expected === "string",
  };
}
