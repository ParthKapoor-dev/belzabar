// `ad grep <regex>`: search the text of method steps (SQL, custom code, SpEL conditions,
// echo expressions and input values). Read-only.
//
// Bodies are read through the `ad callers` machinery (lib/callers.ts): V2 body per method,
// bounded concurrency, and a per-version cache (`<uuid>@<updatedOn>`, env-scoped) holding only
// the extracted step texts, so a re-run or a resumed sweep reads nothing already seen.

import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, CliError, lifecycle } from "@belzabar/core";
import { fetchRawMethod } from "./api/v2";
import { isNotFound, pool, readBodyCached, refsKey, stubFromBody } from "./callers";
import type { MethodFinderMethod } from "./method-finder";
import { parseV2Method } from "./parser/v2";
import type { V2MethodResponse } from "./types/v2-wire";

export const GREP_KINDS = ["sql", "code", "spel"] as const;
export type GrepKind = (typeof GREP_KINDS)[number];

/** One searchable text of a step: its SQL, its custom code, or a SpEL expression / input value. */
interface StepText {
  step: number;
  description?: string;
  kind: GrepKind;
  /** Where in the step the text sits (`sql`, `code`, `condition`, `exitIf`, `input <key>`, …). */
  field: string;
  text: string;
}

export interface GrepMatch {
  method: string;
  category: string;
  state: string;
  uuid: string;
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
const textsCache = new Cache<StepText[]>({ dir: join(BELZ_CONFIG_DIR, "cache", "grep"), ttlMs: TTL });

const EXCERPT_MAX = 200;

/** Every searchable text of a V2 body, decoded (base64 SQL and code come out as source). */
export function stepTextsOf(body: unknown): StepText[] {
  const out: StepText[] = [];
  const method = parseV2Method(body as V2MethodResponse);
  for (const s of method.parsedSteps) {
    const add = (kind: GrepKind, field: string, text: string | null | undefined) => {
      // an echo step's expression is also its input value: report each text once per step
      if (text && text.trim() && !out.some((t) => t.step === s.orderIndex && t.kind === kind && t.text === text)) out.push({ step: s.orderIndex, ...(s.description ? { description: s.description } : {}), kind, field, text });
    };
    if (s.kind === "SQL") add("sql", "sql", s.sql);
    if (s.kind === "CUSTOM_CODE") add("code", "code", s.source);
    if (s.kind === "SPEL_ECHO") add("spel", "expression", s.expression);
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

/** `pattern` as a RegExp; a bad one is INVALID_PATTERN. */
export function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (e) {
    throw new CliError(`Invalid regex '${pattern}': ${(e as Error).message}`, { code: "INVALID_PATTERN", details: { pattern } });
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
 * fresh by uuid). `dirty`: methods belz changed since the index was built (re-read).
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

  await pool(opts.methods, async (m) => {
    try {
      matches.push(...matchTexts(m, await readBodyCached(m, refsKey(m, opts.dirty), textsCache, stepTextsOf, opts.retryFailed), opts.re, opts.kinds));
      scanned++;
    } catch (e) {
      if (!(opts.dirty?.has(m.uuid.toLowerCase()) && isNotFound(e))) errors.push(`${m.categoryName}/${m.methodName} (${m.uuid}): ${e instanceof Error ? e.message : String(e)}`);
    }
    tick();
  });
  await pool(opts.uuids ?? [], async (uuid) => {
    try {
      const body = await fetchRawMethod(uuid);
      matches.push(...matchTexts(stubFromBody(uuid, body), stepTextsOf(body), opts.re, opts.kinds));
      scanned++;
    } catch (e) {
      if (isNotFound(e)) throw e;
      errors.push(`${uuid}: ${e instanceof Error ? e.message : String(e)}`);
    }
    tick();
  });

  matches.sort((a, b) => a.category.localeCompare(b.category) || a.method.localeCompare(b.method) || a.state.localeCompare(b.state) || a.step - b.step || a.line - b.line);
  return { matches, coverage: { scanned, unscanned: total - scanned, ...(errors.length ? { errors } : {}) } };
}
