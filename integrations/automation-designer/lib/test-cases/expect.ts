// Output expectations for `ad test --expect` and test-case assertions.
//
//   out=val     equal            out!=val   not equal
//   out~=val    contains         out>val  out<val  out>=val  out<=val   numeric
//   out.a[0].b=val               path into an output that holds JSON
//   out.size()=3  out[0].size()>1  the size of a list / text / object
//
// The right-hand side is JSON when it parses (42, true, null, {"a":1}),
// else a plain string; quote it ('42' or "42") to force a string. Equality is
// forgiving about the wire: every test output arrives as text, so "42" equals
// 42 and a JSON string equals the parsed value.
//
// Test-case assertions are stored as advance-mode SpEL, in the forms the
// server evaluates (live 2026-10-21, the AD screen's own test route):
//   =  → #{lhs} eq v     != → #{lhs} ne v     > / < → gt / lt
//   ~= → #{lhs.toString()}.contains('v') eq true
// `neq` and an infix `#{x} contains 'v'` (what wi-impl stored before) score
// ERROR on the server: they read back as raw expressions with a warning.
// `lhs` is an output, optionally with a path (`out[0].col`) and `.size()`.

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
  /** `.size()` after the path: compare the size of the value. */
  size?: boolean;
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

const LHS_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)((?:\.(?!size\(\))[A-Za-z0-9_$-]+|\[\d+\])*)(\.size\(\))?\s*/;

function invalid(source: string, why: string, code = "INVALID_EXPECTATION"): CliError {
  // A persisted assertion (`test-case --assert`) is the UI's SpEL: whole outputs only,
  // so it must not suggest `out.path` (the hint contradicted the error).
  const hint =
    code === "INVALID_ASSERTION"
      ? "Use out=value, out!=value, out~=value, out>n, out<n; out[0].col=value and out.size()=n look inside an output."
      : "Use out=value, out!=value, out~=value, out>n, out<n (out.path[0]=value for JSON outputs, out.size()=n for a size).";
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
  const e: Expectation = { source, output: m[1]!, path, op, expected: lit.value, text: lit.text, quoted: lit.quoted };
  if (m[3]) e.size = true;
  return e;
}

function pathText(path: Array<string | number>): string {
  return path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("");
}

function formatExpectation(e: Pick<Expectation, "output" | "path" | "op" | "expected" | "size">): string {
  const rhs = typeof e.expected === "string" ? e.expected : JSON.stringify(e.expected);
  return `${lhsText(e)}${OP_SYMBOL[e.op]}${rhs}`;
}

/** `out`, `out[0].col`, `out.size()`: the left-hand side as typed. */
function lhsText(e: Pick<Expectation, "output" | "path" | "size">): string {
  return `${e.output}${pathText(e.path)}${e.size ? ".size()" : ""}`;
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
  // the test route leaves an empty or null output without a value (wi-impl reads it as null)
  if (actual === null && e.text === "") return true;
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
  // text inside any item, as the stored `#{x.toString()}.contains('v')` does
  if (Array.isArray(v)) return v.some((x) => looseEqual(x, e) || (typeof x === "string" ? x : JSON.stringify(x) ?? "").includes(e.text));
  if (typeof actual === "string") return actual.includes(e.text);
  if (v && typeof v === "object") return Object.prototype.hasOwnProperty.call(v, e.text) || JSON.stringify(v).includes(e.text);
  return actual !== undefined && actual !== null && String(actual).includes(e.text);
}

/** Size of a list, text or object (JSON text is parsed first); undefined for anything else. */
function sizeOf(value: unknown): number | undefined {
  const v = tryJson(value);
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v.length;
  if (v && typeof v === "object") return Object.keys(v).length;
  return undefined;
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
  const actual = e.size ? sizeOf(hit.value) : hit.value;
  if (e.size && actual === undefined) {
    return { ...base, actual: hit.value, pass: false, reason: `${lhsText(e)}: the value has no size` };
  }
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
/** Case-file op names: `ne` is accepted for `neq`. */
const OP_ALIASES: Record<string, AssertOp> = { ne: "neq" };

/** A test-case assertion in the git-friendly case-file form. `output` is the left-hand side: `out`, `out[0].col`, `out.size()`. */
interface StructuredAssertion {
  output: string;
  op: AssertOp;
  expected: string | number | boolean | null;
}

/** An assertion wi-impl cannot read back structurally: kept verbatim. */
interface RawAssertion {
  expression: string | null;
  mode?: string;
  conditions?: unknown;
}

export type CaseAssertion = StructuredAssertion | RawAssertion;

export function isStructured(a: CaseAssertion): a is StructuredAssertion {
  return typeof (a as StructuredAssertion).output === "string";
}

/** A case-file op (`eq`, `neq` or `ne`, `gt`, `lt`, `contains`), or null when unknown. */
export function assertOp(op: unknown): AssertOp | null {
  const s = String(op);
  return (ASSERT_OPS as readonly string[]).includes(s) ? (s as AssertOp) : (OP_ALIASES[s] ?? null);
}

// A left-hand side the server's SpEL takes as written: identifiers, [n] indexes, an optional .size().
const LHS_SRC = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:\.(?!size\(\))[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*(?:\.size\(\))?`;
const LHS_ONLY_RE = new RegExp(`^${LHS_SRC}$`);

/** The output an assertion's left-hand side reads (`out[0].col` → `out`). */
export function assertionOutput(a: StructuredAssertion): string {
  return /^[A-Za-z_][A-Za-z0-9_]*/.exec(a.output)?.[0] ?? a.output;
}

/** `--assert out=value` → a structured assertion (UI operators, scalar value; a path and .size() are allowed). */
export function assertionFromExpectation(e: Expectation): StructuredAssertion {
  const code = "INVALID_ASSERTION";
  if (!(ASSERT_OPS as readonly string[]).includes(e.op)) {
    throw invalid(e.source, `stored assertions take ${ASSERT_OPS.join(", ")} (=, !=, >, <, ~=)`, code);
  }
  const lhs = lhsText(e);
  if (!LHS_ONLY_RE.test(lhs)) throw invalid(e.source, "a stored path takes identifiers and [n] indexes only", code);
  const v = e.expected;
  if (v !== null && typeof v === "object") throw invalid(e.source, "assertion values must be a string, number, boolean or null", code);
  return { output: lhs, op: e.op as AssertOp, expected: v as StructuredAssertion["expected"] };
}

/** SpEL literal: strings single-quoted ('' escapes), numbers/booleans/null bare. */
function spelLiteral(v: StructuredAssertion["expected"]): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

export function assertionExpression(a: StructuredAssertion): string {
  if (a.op === "contains") return `#{${a.output}.toString()}.contains(${spelLiteral(String(a.expected))}) eq true`;
  return `#{${a.output}} ${a.op === "neq" ? "ne" : a.op} ${spelLiteral(a.expected)}`;
}

/** The UI wire shape of one assertion. */
export function assertionToWire(a: CaseAssertion): Record<string, unknown> {
  if (isStructured(a)) return { mode: "advance", conditionExpression: assertionExpression(a), conditions: null };
  const out: Record<string, unknown> = { mode: a.mode ?? "advance", conditionExpression: a.expression };
  out.conditions = a.conditions === undefined ? null : typeof a.conditions === "string" || a.conditions === null ? a.conditions : JSON.stringify(a.conditions);
  return out;
}

const ASSERT_RE = new RegExp(String.raw`^\s*#\{\s*(${LHS_SRC})\s*\}\s+(eq|ne|gt|lt)\s+(.+?)\s*$`);
const CONTAINS_RE = new RegExp(String.raw`^\s*#\{\s*(${LHS_SRC})\.toString\(\)\s*\}\.contains\('((?:[^']|'')*)'\)\s+eq\s+true\s*$`);
// What wi-impl stored for != and ~= up to 0.3.0: the server scores both ERROR.
const LEGACY_RE = /^\s*#\{[^}]*\}\s+(neq|contains)\s+/;

/** Read a stored assertion back: structured when it is one of the forms above, else raw. */
export function assertionFromWire(w: Record<string, unknown>): CaseAssertion {
  const expr = typeof w.conditionExpression === "string" ? w.conditionExpression : null;
  const mode = typeof w.mode === "string" ? w.mode : undefined;
  const plain = expr !== null && (mode === undefined || mode === "advance") && !w.conditions;
  const c = plain ? CONTAINS_RE.exec(expr) : null;
  if (c) return { output: c[1]!, op: "contains", expected: c[2]!.replace(/''/g, "'") };
  const m = plain ? ASSERT_RE.exec(expr) : null;
  if (m) {
    const lit = m[3]!;
    let expected: StructuredAssertion["expected"] | undefined;
    const q = /^'((?:[^']|'')*)'$/.exec(lit);
    if (q) expected = q[1]!.replace(/''/g, "'");
    else if (lit === "null") expected = null;
    else if (lit === "true" || lit === "false") expected = lit === "true";
    else if (/^-?\d+(\.\d+)?$/.test(lit)) expected = Number(lit);
    if (expected !== undefined) return { output: m[1]!, op: m[2] === "ne" ? "neq" : (m[2] as AssertOp), expected };
  }
  const raw: RawAssertion = { expression: expr };
  if (mode !== undefined && mode !== "advance") raw.mode = mode;
  if (w.conditions !== undefined && w.conditions !== null) raw.conditions = tryJson(w.conditions);
  return raw;
}

/**
 * Why a stored assertion cannot pass on the server, or null: the `neq` and
 * infix `contains` forms earlier wi-impl versions wrote score ERROR there.
 */
export function legacyAssertionProblem(a: CaseAssertion): string | null {
  if (isStructured(a) || !a.expression) return null;
  const m = LEGACY_RE.exec(a.expression);
  if (!m) return null;
  const fix = m[1] === "neq" ? "`ne`" : "`#{out.toString()}.contains('v') eq true`";
  return `'${a.expression}' uses ${m[1] === "neq" ? "`neq`" : "an infix `contains`"}, which the server scores ERROR (the working form is ${fix}); write it as {output, op, expected} and re-save the case`;
}

/** A structured assertion as an expectation, so `ad test --case` can evaluate it locally. */
export function expectationFromAssertion(a: StructuredAssertion): Expectation {
  const lhs = parseExpectation(`${a.output}=x`);
  const e: Expectation = {
    source: "",
    output: lhs.output,
    path: lhs.path,
    op: a.op,
    expected: a.expected,
    text: a.expected === null ? "null" : String(a.expected),
    quoted: typeof a.expected === "string",
  };
  if (lhs.size) e.size = true;
  e.source = formatExpectation(e);
  return e;
}
