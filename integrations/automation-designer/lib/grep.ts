// `ad grep <regex>`: search the text of method steps (SQL, custom code, SpEL conditions,
// echo expressions, input values and the names of called methods), and on request the
// method / step descriptions and the test cases. Read-only.
//
// Bodies are read through the `ad callers` machinery (lib/callers.ts): V2 body per method
// (the V1 parse when the V2 route refuses it), bounded concurrency, and a per-version cache
// (`<uuid>@<updatedOn>`, env-scoped) holding only the extracted texts, so a re-run or a
// resumed sweep reads nothing already seen. Test cases are not versioned with the body, so
// `--include tests` reads each method's suite fresh.

import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, CliError, lifecycle } from "@belzabar/core";
import { isNotFound, pool, readBody, readBodyCached, refsKey, stubFromBody } from "./callers";
import type { MethodFinderMethod } from "./method-finder";
import { parseV2Method } from "./parser/v2";
import { fetchSuite } from "./test-cases/suite";
import type { HydratedMethod } from "./types/common";
import type { V2MethodResponse } from "./types/v2-wire";

/** Kinds `--in` selects (default: all of them). */
export const GREP_KINDS = ["sql", "code", "spel", "call"] as const;
/** Extra texts `--include` adds, and the match kind each one yields. */
export const GREP_INCLUDES = { descriptions: "description", tests: "test" } as const;
export type GrepInclude = keyof typeof GREP_INCLUDES;
export type GrepKind = (typeof GREP_KINDS)[number] | (typeof GREP_INCLUDES)[GrepInclude];

/** One searchable text of a method: a step's SQL, code, SpEL, call target or description, or a method-level text (step 0). */
interface StepText {
  step: number;
  description?: string;
  kind: GrepKind;
  /** Where the text sits (`sql`, `code`, `condition`, `exitIf`, `input <key>`, `call`, `description`, `test <case> …`). */
  field: string;
  text: string;
}

export interface GrepMatch {
  method: string;
  category: string;
  state: string;
  uuid: string;
  /** Step number; 0 for a method-level text (method summary / description, test cases). */
  step: number;
  stepDescription?: string;
  kind: GrepKind;
  field: string;
  /** 1-based line within the field's text. */
  line: number;
  excerpt: string;
}

export interface GrepCoverage {
  /** Methods whose body was searched. */
  scanned: number;
  /** Methods in scope whose body could not be read. */
  unscanned: number;
  errors?: string[];
}

const TTL = 30 * 24 * 60 * 60 * 1000; // keyed by uuid@updatedOn: an edit changes the key
// `grep-texts`: the texts gained call targets and descriptions (the old `grep` entries lack them).
const textsCache = new Cache<StepText[]>({ dir: join(BELZ_CONFIG_DIR, "cache", "grep-texts"), ttlMs: TTL });

const EXCERPT_MAX = 200;

/** Every searchable text of a V2 body, decoded (base64 SQL and code come out as source). */
export function stepTextsOf(body: unknown): StepText[] {
  return methodTextsOf(parseV2Method(body as V2MethodResponse));
}

/** Every searchable text of a parsed method (V2, or the V1 parse when V2 refuses the body). */
export function methodTextsOf(method: HydratedMethod): StepText[] {
  const out: StepText[] = [];
  const top = (field: string, text: string | undefined) => {
    if (text && text.trim() && !out.some((t) => t.step === 0 && t.text === text)) out.push({ step: 0, kind: "description", field, text });
  };
  top("summary", method.storedSummary);
  top("description", method.description);
  for (const s of method.parsedSteps) {
    const add = (kind: GrepKind, field: string, text: string | null | undefined) => {
      // an echo step's expression is also its input value: report each text once per step
      if (text && text.trim() && !out.some((t) => t.step === s.orderIndex && t.kind === kind && t.text === text)) out.push({ step: s.orderIndex, ...(s.description ? { description: s.description } : {}), kind, field, text });
    };
    if (s.kind === "SQL") add("sql", "sql", s.sql);
    if (s.kind === "CUSTOM_CODE") add("code", "code", s.source);
    if (s.kind === "SPEL_ECHO") add("spel", "expression", s.expression);
    // a call to another method or service: `Category/method`, as the matches print a method
    if (s.kind === "EXISTING_SERVICE" && s.methodName) add("call", "call", s.serviceName ? `${s.serviceName}/${s.methodName}` : s.methodName);
    add("description", "description", s.description);
    add("spel", "condition", s.conditionExpression);
    add("spel", "exitIf", s.forceReturnExpression);
    const walk = (inputs: typeof s.inputs, prefix: string) => {
      for (const i of inputs) {
        const key = prefix ? `${prefix}.${i.key ?? "?"}` : (i.key ?? "?");
        // the SQL slot is already searched as `sql`
        if (!(s.kind === "SQL" && i.key === "queryString")) add("spel", `input ${key}`, i.value);
        if (i.mappings?.length) walk(i.mappings, key);
      }
    };
    walk(s.inputs, "");
  }
  return out;
}

/** The texts of a method's active test cases: name, description, each input value and assertion. */
async function testTextsOf(uuid: string): Promise<StepText[]> {
  const out: StepText[] = [];
  const add = (field: string, v: unknown) => {
    const text = typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v);
    if (text.trim()) out.push({ step: 0, kind: "test", field, text });
  };
  for (const { file } of (await fetchSuite(uuid)).cases) {
    const at = `test ${file.name || "(unnamed)"}`;
    add(`${at} name`, file.name);
    add(`${at} description`, file.description);
    for (const [k, v] of Object.entries(file.inputs)) add(`${at} input ${k}`, v);
    for (const a of file.assertions) add(`${at} assertion`, a);
  }
  return out;
}

/**
 * `pattern` as a RegExp; a bad one is INVALID_PATTERN. A leading `(?i)` (PCRE / Java inline
 * flag, which JavaScript lacks) is read as `--ignore-case`.
 */
export function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  const inline = pattern.startsWith("(?i)");
  const source = inline ? pattern.slice(4) : pattern;
  try {
    return new RegExp(source, ignoreCase || inline ? "i" : "");
  } catch (e) {
    const hint = /\(\?[a-z]/i.test(source) ? " Inline flags like (?s) are not JavaScript regex; for case-insensitive use -i (or a leading (?i))." : "";
    throw new CliError(`Invalid regex '${pattern}': ${(e as Error).message}.${hint}`, { code: "INVALID_PATTERN", details: { pattern } });
  }
}

function excerpt(line: string): string {
  const t = line.trim();
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX)}…` : t;
}

function matchTexts(m: MethodFinderMethod, texts: StepText[], re: RegExp, kinds: ReadonlySet<GrepKind>): GrepMatch[] {
  const out: GrepMatch[] = [];
  for (const t of texts) {
    if (!kinds.has(t.kind)) continue;
    t.text.split("\n").forEach((line, i) => {
      if (!re.test(line)) return;
      out.push({
        method: m.methodName,
        category: m.categoryName,
        state: m.state,
        uuid: m.uuid,
        step: t.step,
        ...(t.description ? { stepDescription: t.description } : {}),
        kind: t.kind,
        field: t.field,
        line: i + 1,
        excerpt: excerpt(line),
      });
    });
  }
  return out;
}

/**
 * Search `methods` (index records, read through the per-version cache) plus `uuids` (read
 * fresh by uuid). `dirty`: methods wi-impl changed since the index was built (re-read).
 * `kinds` holding `test` also reads each method's test cases.
 */
export async function grepMethods(
  opts: {
    methods: MethodFinderMethod[];
    uuids?: string[];
    dirty?: Map<string, number>;
    re: RegExp;
    kinds: ReadonlySet<GrepKind>;
    retryFailed?: boolean;
  },
): Promise<{ matches: GrepMatch[]; coverage: GrepCoverage }> {
  const matches: GrepMatch[] = [];
  const errors: string[] = [];
  let scanned = 0;
  let done = 0;
  const total = opts.methods.length + (opts.uuids?.length ?? 0);
  const tick = () => {
    done++;
    if (total > 20 && (done % 50 === 0 || done === total)) lifecycle.notice(`Reading method bodies: ${done}/${total}`);
  };
  const tests = async (m: MethodFinderMethod) => {
    if (!opts.kinds.has("test")) return;
    try {
      matches.push(...matchTexts(m, await testTextsOf(m.uuid), opts.re, opts.kinds));
    } catch (e) {
      errors.push(`${m.categoryName}/${m.methodName} (${m.uuid}) test cases: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await pool(opts.methods, async (m) => {
    try {
      matches.push(...matchTexts(m, await readBodyCached(m, refsKey(m, opts.dirty), textsCache, stepTextsOf, opts.retryFailed, methodTextsOf), opts.re, opts.kinds));
      scanned++;
      await tests(m);
    } catch (e) {
      if (!(opts.dirty?.has(m.uuid.toLowerCase()) && isNotFound(e))) errors.push(`${m.categoryName}/${m.methodName} (${m.uuid}): ${e instanceof Error ? e.message : String(e)}`);
    }
    tick();
  });
  await pool(opts.uuids ?? [], async (uuid) => {
    try {
      const { stub, texts } = await readBody(
        uuid,
        (body) => ({ stub: stubFromBody(uuid, body), texts: stepTextsOf(body) }),
        (method) => ({ stub: stubFromMethod(uuid, method), texts: methodTextsOf(method) }),
      );
      matches.push(...matchTexts(stub, texts, opts.re, opts.kinds));
      scanned++;
      await tests(stub);
    } catch (e) {
      if (isNotFound(e)) throw e;
      errors.push(`${uuid}: ${e instanceof Error ? e.message : String(e)}`);
    }
    tick();
  });

  matches.sort((a, b) => a.category.localeCompare(b.category) || a.method.localeCompare(b.method) || a.state.localeCompare(b.state) || a.step - b.step || a.line - b.line);
  return { matches, coverage: { scanned, unscanned: total - scanned, ...(errors.length ? { errors } : {}) } };
}

/** An index-shaped record from a parsed method (the V1 fallback of a `--method` read). */
function stubFromMethod(uuid: string, method: HydratedMethod): MethodFinderMethod {
  return { ...stubFromBody(uuid, {}), methodName: method.name || uuid, state: method.state, categoryName: method.category?.name ?? "" };
}
