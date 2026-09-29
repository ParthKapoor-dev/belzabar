// `belz ad lint` rules: review heuristics that
// the pre-save validator (L1–L4) does not enforce. Every rule here is ADVISORY
// (warn): they look for patterns that usually mean a slow, fragile or
// reimplemented step, and can be wrong on a given method.
//
// Rules —
//   SQL: Q2 per-row subquery, Q3 raw read
//   of a resolver-guarded config table, Q4 re-looking-up a bound value
//   (Q1 bare `?`, Q5 autoformat damage and AD-SQL-004 `#{}` in SQL are
//   validator rules already);
//   AD anti-patterns: JSON-juggling custom code, a DB step without a
//   table, replacePlaceholdersInText building SQL;
//   platform prose: reserved key `language`, >30 steps, echo read/write race,
//   string `+` on numeric inputs, variable BASE_64 stripped, FLOAT defaults
//   truncated, descriptions (opt-in: `docs`).
//
// Input: the V2 wire body, like lib/validate/index.ts.

import { arr, str, type ValidationFinding } from "./types";
import { jsonPath, stepKind, stepRef } from "./schema";
import { customCodeSource, escapeRe, findSqlInput, sqlSkeleton } from "./steps";
import { replaceSpelBlocks, scanSpel, spelRoots } from "./spel";
import { decodeBase64Strict } from "../base64";
import { isObj, str as nonBlank, type Obj } from "@belzabar/core";

interface LintRuleInfo {
  description: string;
}

export const LINT_RULES = {
  Q2: { description: "SELECT-list subquery runs once per row; if its value does not depend on the row, bind it once (CTE, join or :param)" },
  Q3: { description: "Raw read of a table that must be read through a resolver function (config lint.resolverTables)" },
  Q4: { description: "Query only returns columns it already filters by equality to a bound value (re-looks up a value the step already has)" },
  "AD-LINT-001": { description: "Custom code only parses JSON, reads/sets one key and stringifies it; use Helpers.JSON/fetchKeyValue or setOrUpdateElement" },
  "AD-LINT-002": { description: "db_service SQL reads no table (no FROM/JOIN/INTO/UPDATE); compute it with SpEL or a helper instead of a DB round trip" },
  "AD-LINT-003": { description: "SQL text is built by a replacePlaceholdersInText step; use :param placeholders + body.queryParams" },
  "AD-LINT-004": { description: "Input/variable key 'language' collides with Helpers.Localization" },
  "AD-LINT-005": { description: "More than 30 steps: slow to load and review; split into sub-methods" },
  "AD-LINT-006": { description: "Echo step reads #{v} and writes v (inputReference) in the same step" },
  "AD-LINT-007": { description: "'+' between two numeric inputs/variables concatenates text ('8' + '3' = '83'); cast with T(java.lang.Integer).parseInt(…)" },
  "AD-LINT-008": { description: "Variable encodingType BASE_64 is silently stripped on save; encode at the step input" },
  "AD-LINT-009": { description: "FLOAT defaultValue has more than 6 significant digits; the platform truncates it" },
  "AD-LINT-010": { description: "Missing description (method, summary, inputs, outputs, steps) — the team's design principle #6 (lint --docs)" },
} as const satisfies Record<string, LintRuleInfo>;

/** Every lint finding names a rule of the catalogue above. */
type Report = (f: Omit<ValidationFinding, "severity"> & { rule: keyof typeof LINT_RULES }) => void;

interface LintOptions {
  /** Also report missing descriptions (AD-LINT-010). */
  docs?: boolean;
  /**
   * Q3: table name → the resolver function that must be used to read it
   * (config `lint.resolverTables`; project-specific, so nothing is built in).
   */
  resolverTables?: Record<string, string>;
}



/** Q3 matchers from `LintOptions.resolverTables` (a table matches with or without a schema prefix). */
function resolvedTables(map: Record<string, string> | undefined): Array<{ table: RegExp; resolver: string }> {
  return Object.entries(map ?? {})
    .filter(([table, resolver]) => table.trim() && resolver.trim())
    .map(([table, resolver]) => ({ table: new RegExp(`\\b(?:\\w+\\.)?${escapeRe(table.trim())}\\b`, "i"), resolver: resolver.trim() }));
}

const NUMERIC_TYPES = new Set(["NUMBER", "INTEGER", "FLOAT", "DOUBLE", "LONG", "DECIMAL"]);

export function lintMethodV2(body: unknown, opts: LintOptions = {}): ValidationFinding[] {
  if (!isObj(body)) return [];
  const out: ValidationFinding[] = [];
  const report: Report = (f) => void out.push({ severity: "warn", ...f });
  const steps = arr(body.steps);
  const resolvers = resolvedTables(opts.resolverTables);

  // ── method-level ────────────────────────────────────────────────────────
  const numeric = new Set<string>();
  for (const list of ["inputs", "variables"] as const) {
    arr(body[list]).forEach((f, i) => {
      if (!isObj(f)) return;
      const key = str(f.key) ?? "";
      const type = (str(f.type) ?? "").toUpperCase();
      if (NUMERIC_TYPES.has(type)) numeric.add(key);
      if (key === "language") {
        report({ rule: "AD-LINT-004", message: `${list === "inputs" ? "Input" : "Variable"} key 'language' collides with Helpers.Localization.`, path: jsonPath([list, i, "key"]), fix: "Rename it (e.g. languageCode)." });
      }
      if (list === "variables" && f.encodingType === "BASE_64") {
        report({ rule: "AD-LINT-008", message: `Variable "${key}" has encodingType BASE_64, which the save silently strips.`, path: jsonPath([list, i, "encodingType"]), fix: "Encode at the step input that consumes it." });
      }
      if (type === "FLOAT" && typeof f.defaultValue === "string" && significantDigits(f.defaultValue) > 6) {
        report({ rule: "AD-LINT-009", message: `FLOAT "${key}" defaultValue ${f.defaultValue} has more than 6 significant digits; it is truncated.`, path: jsonPath([list, i, "defaultValue"]) });
      }
    });
  }
  if (steps.length > 30) {
    report({ rule: "AD-LINT-005", message: `${steps.length} steps; methods above ~30 steps are slow in the UI and hard to review.`, path: "steps", fix: "Move cohesive parts into published sub-methods." });
  }
  if (opts.docs) docs(body, report);

  // Which step output names come from replacePlaceholdersInText (AD-LINT-003).
  const placeholderOutputs = new Map<string, number>();

  steps.forEach((s, i) => {
    if (!isObj(s)) return;
    const ref = stepRef(s, i);
    const kind = stepKind(s);
    const at = (...rest: Array<string | number>) => jsonPath(["steps", i, ...rest]);
    const props = isObj(s.properties) ? s.properties : {};

    if (kind === "CUSTOM_CODE") {
      const cc = isObj(props.customCode) ? props.customCode : {};
      const code = str(cc.inlineCode);
      if (code && isJsonJuggling(customCodeSource(code))) {
        report({ rule: "AD-LINT-001", message: "Custom code only parses JSON, touches one key and stringifies it.", path: at("properties", "customCode", "inlineCode"), step: ref, fix: "Use Helpers.JSON/fetchKeyValue (read) or Helpers.JSON/setOrUpdateElement (write): no lambda cold start." });
      }
    }

    if (kind === "SQL") lintSql(s, ref, at, placeholderOutputs, report, resolvers);

    if (kind === "SPEL_ECHO") {
      const value = firstInputValue(s);
      const writes = arr(s.outputs).map((o) => (isObj(o) && isObj(o.inputReference) ? nonBlank(o.inputReference.reference) : undefined)).filter(Boolean) as string[];
      if (value) {
        const reads = new Set(scanSpel(value).blocks.flatMap((b) => spelRoots(b.body)));
        for (const w of writes) {
          if (reads.has(w)) {
            report({ rule: "AD-LINT-006", message: `Echo reads #{${w}} and writes ${w} in the same step.`, path: at("outputs"), step: ref, fix: "Write to a new variable, or split read and write into two steps." });
          }
        }
      }
    }

    // AD-LINT-007: numeric + numeric in any SpEL value of this step.
    for (const { value, path } of spelValues(s)) {
      for (const b of scanSpel(value).blocks) {
        if (/\bT\s*\(/.test(b.body)) continue;
        const m = /(?:^|[^\w.#$])([A-Za-z_]\w*)\s*\+\s*([A-Za-z_]\w*)(?![\w(.])/.exec(b.body);
        if (m && numeric.has(m[1]!) && numeric.has(m[2]!)) {
          report({ rule: "AD-LINT-007", message: `#{${b.body.trim()}} adds two numeric inputs/variables; SpEL concatenates their text.`, path: at(...path), step: ref, fix: `#{T(java.lang.Integer).parseInt(${m[1]}) + T(java.lang.Integer).parseInt(${m[2]})}` });
        }
      }
    }

    if (str(s.methodName) === "replacePlaceholdersInText") {
      for (const o of arr(s.outputs)) {
        if (!isObj(o)) continue;
        for (const name of [nonBlank(o.fieldCode), nonBlank(o.name), isObj(o.inputReference) ? nonBlank(o.inputReference.reference) : undefined]) {
          if (name) placeholderOutputs.set(name, i + 1);
        }
      }
    }
  });
  return out;
}

// ── SQL ───────────────────────────────────────────────────────────────────

function lintSql(
  s: Obj,
  ref: ValidationFinding["step"],
  at: (...rest: Array<string | number>) => string,
  placeholderOutputs: Map<string, number>,
  report: Report,
  resolvers: Array<{ table: RegExp; resolver: string }>,
): void {
  const q = findSqlInput(s);
  const raw = q && typeof q.inp.value === "string" ? q.inp.value : "";
  if (!raw.trim()) return;
  const flagged = q!.inp.encodingType === "BASE_64" || q!.inp.encodedBase64 === true;
  const sql = flagged ? decodeBase64Strict(raw) ?? raw : raw;
  const path = at(...q!.path, "value");

  // AD-LINT-003: the whole SQL text (or part of it) comes from replacePlaceholdersInText.
  for (const b of scanSpel(sql).blocks) {
    for (const root of spelRoots(b.body)) {
      const from = placeholderOutputs.get(root);
      if (from !== undefined) {
        report({ rule: "AD-LINT-003", message: `SQL uses #{${root}}, built by replacePlaceholdersInText in step ${from}.`, path, step: ref, fix: "Write the SQL with :name placeholders and pass values in body.queryParams [{key, value, type}]." });
      }
    }
  }

  const skel = sqlSkeleton(replaceSpelBlocks(sql, ":spel")).replace(/\s+/g, " ").trim();
  const lower = skel.toLowerCase();

  // AD-LINT-002: no table at all.
  if (/^\(?\s*(select|with|values)\b/.test(lower) && !/\b(from|join|into|update)\b/.test(lower)) {
    report({ rule: "AD-LINT-002", message: "SQL reads no table; this is a database round trip for a computation.", path, step: ref, fix: "Use SpEL (e.g. T(java.time.LocalDate).now()) or a Helpers.* service." });
  }

  // Q3: resolver-guarded config tables.
  for (const r of resolvers) {
    const hit = r.table.exec(skel);
    if (hit && !new RegExp(`\\b${r.resolver}\\b`, "i").test(skel)) {
      report({ rule: "Q3", message: `SQL reads ${hit[0]} directly; its value must come from ${r.resolver}().`, path, step: ref, fix: `SELECT … FROM ${r.resolver}(…)` });
    }
  }

  // Q2: a scalar subquery in the outer SELECT list.
  const outer = outerSelectList(lower);
  if (outer !== undefined && /\(\s*select\b/.test(outer)) {
    report({ rule: "Q2", message: "A subquery in the SELECT list runs once per returned row.", path, step: ref, fix: "If it does not depend on the row, compute it once (CTE / CROSS JOIN / :param); else use a join." });
  }

  // Q4: every returned column is filtered by equality to a bound value.
  const q4 = relookup(lower);
  if (q4) {
    report({ rule: "Q4", message: `The query returns ${q4} but filters it by equality to a bound value it already has.`, path, step: ref, fix: "Use the bound value directly; for an existence check use SELECT EXISTS(…)." });
  }
}

/** The outer SELECT list: text between the first top-level SELECT and its FROM (depth 0). */
function outerSelectList(lower: string): string | undefined {
  const start = /^\s*\(?\s*select\b/.exec(lower);
  if (!start) return undefined;
  let depth = 0;
  for (let i = start[0].length; i < lower.length; i++) {
    const c = lower[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /\bfrom\b/.test(lower.slice(i, i + 5)) && /\W/.test(lower[i - 1] ?? " ")) return lower.slice(start[0].length, i);
  }
  return lower.slice(start[0].length);
}

/** `select a, b from t where a = :x and b = :y` → "a, b"; undefined otherwise. */
function relookup(lower: string): string | undefined {
  const m = /^\s*select\s+(.+?)\s+from\s+[\w."]+(?:\s+(?:as\s+)?\w+)?\s+where\s+(.+?)(?:\s+(?:limit|order|group)\b.*)?$/.exec(lower);
  if (!m || /[()*]/.test(m[1]!) || /\b(or|join)\b/.test(m[2]!)) return undefined;
  const cols = m[1]!.split(",").map((c) => c.trim().replace(/^\w+\./, ""));
  if (cols.some((c) => !/^\w+$/.test(c))) return undefined;
  const bound = new Set<string>();
  for (const cond of m[2]!.split(/\band\b/)) {
    const e = /^\s*(?:\w+\.)?(\w+)\s*=\s*(:\w+)\s*$/.exec(cond);
    if (e) bound.add(e[1]!);
  }
  return cols.length > 0 && cols.every((c) => bound.has(c)) ? cols.join(", ") : undefined;
}

// ── custom code / values ──────────────────────────────────────────────────

/** JSON.parse → ≤1 key get/set → JSON.stringify, in a short body. */
export function isJsonJuggling(src: string): boolean {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 8 || !/JSON\.parse\s*\(/.test(code)) return false;
  if (/\b(for|while|if|switch|map|filter|reduce|forEach|function|=>)\b|=>/.test(code)) return false;
  const accesses = new Set<string>();
  for (const m of code.matchAll(/\b[A-Za-z_$][\w$]*((?:\.[A-Za-z_$][\w$]*|\[['"][^'"]+['"]\])+)/g)) {
    const chain = m[1]!;
    if (/^\.(parse|stringify|log|length)$/.test(chain) || /^\.(log|error)/.test(chain)) continue;
    accesses.add(chain);
  }
  // parse → one key → stringify (setOrUpdateElement), or parse → print one key (fetchKeyValue).
  return /JSON\.stringify\s*\(/.test(code) ? accesses.size <= 1 : accesses.size === 1;
}

function firstInputValue(s: Obj): string | undefined {
  for (const inp of arr(s.inputs)) if (isObj(inp) && typeof inp.value === "string") return inp.value;
  return undefined;
}

function spelValues(s: Obj): Array<{ value: string; path: Array<string | number> }> {
  const out: Array<{ value: string; path: Array<string | number> }> = [];
  const walk = (inputs: unknown, base: Array<string | number>) =>
    arr(inputs).forEach((inp, i) => {
      if (!isObj(inp)) return;
      if (typeof inp.value === "string" && inp.value.includes("#{")) out.push({ value: inp.value, path: [...base, i, "value"] });
      walk(inp.properties, [...base, i, "properties"]);
    });
  walk(s.inputs, ["inputs"]);
  const props = isObj(s.properties) ? s.properties : {};
  const entry = isObj(props.entryCondition) ? str(props.entryCondition.expression) : undefined;
  if (entry?.includes("#{")) out.push({ value: entry, path: ["properties", "entryCondition", "expression"] });
  return out;
}

function significantDigits(v: string): number {
  const d = v.trim().replace(/^[-+]/, "").replace(/e.*$/i, "").replace(".", "").replace(/^0+/, "");
  return /^\d+$/.test(d) ? d.length : 0;
}

function docs(body: Obj, report: Report): void {
  const missing: string[] = [];
  if (!nonBlank(body.description)) missing.push("description");
  if (!nonBlank(body.summary)) missing.push("summary");
  if (missing.length > 0) {
    report({ rule: "AD-LINT-010", message: `Method has no ${missing.join(" or ")}.`, path: missing[0]! });
  }
  for (const list of ["inputs", "outputs", "variables"] as const) {
    const keys = arr(body[list]).filter((f) => isObj(f) && !nonBlank(f.description)).map((f) => str((f as Obj).key) ?? "?");
    if (keys.length > 0) report({ rule: "AD-LINT-010", message: `${list} without a description: ${keys.join(", ")}.`, path: list });
  }
  arr(body.steps).forEach((s, i) => {
    if (!isObj(s)) return;
    if (!nonBlank(s.description)) report({ rule: "AD-LINT-010", message: "Step has no description.", path: jsonPath(["steps", i, "description"]), step: stepRef(s, i) });
    const exit = isObj(s.properties) && isObj(s.properties.exitCondition) && isObj(s.properties.exitCondition.exitOnFailure) ? s.properties.exitCondition.exitOnFailure : undefined;
    if (exit?.value === true && !nonBlank(exit.message)) {
      report({ rule: "AD-LINT-010", message: "Step exits on failure without a message.", path: jsonPath(["steps", i, "properties", "exitCondition", "exitOnFailure", "message"]), step: stepRef(s, i) });
    }
  });
}
