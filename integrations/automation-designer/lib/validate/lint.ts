// `wi-impl ad lint` rules: review heuristics that
// the pre-save validator (L1–L4) does not enforce. Every rule here is ADVISORY
// (warn): they look for patterns that usually mean a slow, fragile or
// reimplemented step, and can be wrong on a given method.
//
// Rules —
//   SQL: Q2 per-row subquery, Q3 raw read
//   of a resolver-guarded config table, Q4 re-looking-up a bound value,
//   Q6 a uuid-like column compared as text to a bound value
//   (Q1 bare `?`, Q5 autoformat damage and AD-SQL-004 `#{}` in SQL are
//   validator rules already);
//   AD anti-patterns: JSON-juggling custom code, a DB step without a
//   table, replacePlaceholdersInText building SQL;
//   platform prose: reserved key `language`, >30 steps, echo read/write race,
//   string `+` on numeric inputs, variable BASE_64 stripped, FLOAT defaults
//   truncated, descriptions (opt-in: `docs`);
//   Report Designer datasources (a method with a reportColumns / reportData
//   output): exactly one step, no trailing whitespace after the SQL, lower-case
//   input keys;
//   runtime traps (live): a data.read rowsImpacted without flatData[] is
//   always 0, a JSON/list value quoted into a TEXT query parameter, Jackson-only
//   calls on a JSON input (a Map on the test route).
//
// Input: the V2 wire body, like lib/validate/index.ts.

import { arr, str, type ValidationFinding } from "./types";
import { jsonPath, stepKind, stepRef, walkInputs } from "./schema";
import { customCodeSource, escapeRe, findSqlInput, sqlSkeleton } from "./steps";
import { replaceSpelBlocks, scanSpel, spelRoots, stripStrings } from "./spel";
import { classifyService } from "../parser/steps/classify";
import { decodeBase64Strict } from "../base64";
import { isObj, str as nonBlank, type Obj } from "@belzabar/core";

interface LintRuleInfo {
  description: string;
}

export const LINT_RULES = {
  Q2: { description: "SELECT-list subquery runs once per row; if its value does not depend on the row, bind it once (CTE, join or :param)" },
  Q3: { description: "Raw read of a table that must be read through a resolver function (config lint.resolverTables)" },
  Q4: { description: "Query only returns columns it already filters by equality to a bound value (re-looks up a value the step already has)" },
  Q6: { description: "A uuid-like column cast to text and compared to a bound value misses equal uuids spelled differently (case, braces, dashes); compare as uuid" },
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
  "AD-LINT-011": { description: "Report Designer datasource with more than one step: RD marks it corrupted and shows only the raw outputs as columns" },
  "AD-LINT-012": { description: "Report Designer datasource SQL ends with whitespace or a newline: RD's column discovery silently falls back to the raw outputs" },
  "AD-LINT-013": { description: "Report Designer datasource input key with upper-case letters: RD fills filters only into inputs named like the column in lower case" },
  "AD-LINT-014": { description: "db_service data.read maps rowsImpacted without flatData[]: the count is then always 0 (live); map flatData[] too, or count in SQL" },
  "AD-LINT-015": { description: "A JSON/list input or variable quoted into a TEXT/STRING queryParams value (\"value\":\"#{x}\"): its own quotes break the parameter JSON and every run fails; use \"type\":\"JSON\" with an unquoted #{x} and :x::jsonb" },
  "AD-LINT-016": { description: "Jackson-only call (hasNonNull, path, has, asText…) on a JSON input: on the test route the input is a Map, so the block is not evaluated; use property access (x.k, x['k'] != null)" },
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
/** Method field types whose value is a JSON object or list (AD-LINT-015). */
const JSON_TYPES = new Set(["JSON", "ARRAY", "OBJECT"]);
/**
 * Jackson JsonNode methods a java.util.Map lacks (AD-LINT-016). Live on the
 * test route: `#{payload.hasNonNull('k')}`, `.path('k')` and `.has('k')` come
 * back as their literal text, while `.get('k')`, `.containsKey('k')`,
 * `payload.k` and `payload['k']` work.
 */
const JACKSON_ONLY = [
  "hasNonNull", "has", "path", "isNull", "isMissingNode", "asText", "asInt", "asLong", "asDouble", "asBoolean",
  "textValue", "isTextual", "isNumber", "isArray", "isObject", "fieldNames", "elements", "findValue",
];
const JACKSON_CALL = new RegExp(String.raw`(?<![\w.#$@])([A-Za-z_]\w*)(?:\.[A-Za-z_]\w*(?![\w(]|\s*\())*\.(${JACKSON_ONLY.join("|")})\s*\(`, "g");

export function lintMethodV2(body: unknown, opts: LintOptions = {}): ValidationFinding[] {
  if (!isObj(body)) return [];
  const out: ValidationFinding[] = [];
  const report: Report = (f) => void out.push({ severity: "warn", ...f });
  const steps = arr(body.steps);
  const resolvers = resolvedTables(opts.resolverTables);

  // ── method-level ────────────────────────────────────────────────────────
  const numeric = new Set<string>();
  const jsonValued = new Set<string>();
  const jsonInputs = new Set<string>();
  for (const list of ["inputs", "variables"] as const) {
    arr(body[list]).forEach((f, i) => {
      if (!isObj(f)) return;
      const key = str(f.key) ?? "";
      const type = (str(f.type) ?? "").toUpperCase();
      if (NUMERIC_TYPES.has(type)) numeric.add(key);
      if (JSON_TYPES.has(type)) jsonValued.add(key);
      if (list === "inputs" && type === "JSON") jsonInputs.add(key);
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
  if (isReportDatasource(body)) reportDatasource(body, steps, report);

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

    if (kind === "SQL") {
      lintSql(s, ref, at, placeholderOutputs, report, resolvers);
      readCountTrap(s, ref, at, report);
      quotedJsonParams(s, ref, at, jsonValued, report);
    }

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

    // AD-LINT-016: Jackson-only calls on a JSON input.
    if (jsonInputs.size > 0) {
      for (const { value, path } of spelValues(s)) {
        for (const b of scanSpel(value).blocks) {
          for (const m of (stripStrings(b.body) ?? "").matchAll(JACKSON_CALL)) {
            if (!jsonInputs.has(m[1]!)) continue;
            report({
              rule: "AD-LINT-016",
              message: `#{${b.body.trim()}} calls ${m[2]}() on the JSON input ${m[1]}; on the test route a JSON input is a Map, which has no ${m[2]}(), so the block is not evaluated (its text flows on).`,
              path: at(...path),
              step: ref,
              fix: `Use property access: #{${m[1]}.k != null ? ${m[1]}.k : null} (or ${m[1]}['k']); test the step on both routes (ad test, ad run).`,
            });
            break;
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

  // Q2: a scalar subquery in the outer SELECT list. Without an outer FROM the
  // query returns one row, so the subquery runs once (`select coalesce((select
  // …), false)`); a subquery inside EXISTS(…) is a single boolean.
  const outer = outerSelectList(lower);
  if (outer?.hasFrom && /(?<!\bexists\s*)\(\s*select\b/.test(outer.list)) {
    report({ rule: "Q2", message: "A subquery in the SELECT list runs once per returned row.", path, step: ref, fix: "If it does not depend on the row, compute it once (CTE / CROSS JOIN / :param); else use a join." });
  }

  // Q4: every returned column is filtered by equality to a bound value.
  const q4 = relookup(lower);
  if (q4) {
    report({ rule: "Q4", message: `The query returns ${q4} but filters it by equality to a bound value it already has.`, path, step: ref, fix: "Use the bound value directly; for an existence check use SELECT EXISTS(…)." });
  }

  // Q6: <id-like col>::text compared to a bound value.
  const q6 = uuidTextComparison(sql);
  if (q6) {
    report({
      rule: "Q6",
      message: `${q6}::text is compared to a bound value as text: equal uuids spelled differently (upper case, braces, no dashes) do not match.`,
      path,
      step: ref,
      fix: `Compare as uuid: ${q6} = '#{x}'::uuid (or :param::uuid).`,
    });
  }
}

/** AD-LINT-014: a data.read step maps rowsImpacted but not flatData[] (live: rowsImpacted is then 0 for every SELECT). */
function readCountTrap(s: Obj, ref: ValidationFinding["step"], at: (...rest: Array<string | number>) => string, report: Report): void {
  const family = classifyService({ system: str(s.serviceName) ?? "", api: str(s.methodName) ?? "" });
  if (family.kind !== "SQL" || family.operation !== "read") return;
  const keys = arr(s.outputs).map((o) => (isObj(o) ? str(o.key) ?? "" : ""));
  const i = keys.indexOf("rowsImpacted");
  if (i < 0 || keys.some((k) => k.startsWith("flatData"))) return;
  report({
    rule: "AD-LINT-014",
    message: "A data.read step maps rowsImpacted without flatData[]: the platform counts the rows only when flatData[] is mapped too, so this output is always 0.",
    path: at("outputs", i, "key"),
    step: ref,
    fix: 'Also map flatData[] (e.g. {"rows": "flatData[]"}), or return the count from the SQL (SELECT count(*) …, SELECT EXISTS(…)).',
  });
}

/**
 * AD-LINT-015: a queryParams entry of type TEXT/STRING whose value is exactly
 * "#{x}" with x a JSON/ARRAY/OBJECT input or variable. The rendered list or
 * object carries its own quotes, which end the JSON string early (live:
 * "Cannot construct instance of QueryParam"); the JSON form works.
 */
function quotedJsonParams(
  s: Obj,
  ref: ValidationFinding["step"],
  at: (...rest: Array<string | number>) => string,
  jsonValued: Set<string>,
  report: Report,
): void {
  if (jsonValued.size === 0) return;
  walkInputs(s.inputs, ["inputs"], (inp, path) => {
    if (str(inp.key) !== "queryParams" || typeof inp.value !== "string") return;
    const flagged = inp.encodingType === "BASE_64" || inp.encodedBase64 === true;
    const text = flagged ? decodeBase64Strict(inp.value) ?? inp.value : inp.value;
    // One entry per {…} without nested braces once each #{…} is a token.
    const blocks: string[] = [];
    const flat = text.replace(/#\{([^{}]*)\}/g, (_m, b: string) => `@@${blocks.push(b) - 1}@@`);
    for (const entry of flat.match(/\{[^{}]*\}/g) ?? []) {
      const type = /"type"\s*:\s*"(TEXT|STRING)"/i.exec(entry)?.[1];
      const value = /"value"\s*:\s*"@@(\d+)@@"/.exec(entry);
      const name = value ? blocks[Number(value[1])]!.trim() : "";
      if (!type || !jsonValued.has(name)) continue;
      const key = /"key"\s*:\s*"([^"]*)"/.exec(entry)?.[1] ?? name;
      report({
        rule: "AD-LINT-015",
        message: `queryParams "${key}" is type ${type.toUpperCase()} with the quoted value "#{${name}}", but ${name} is a JSON/list value: its own quotes break the parameter JSON and every run fails ("Cannot construct instance of QueryParam").`,
        path: at(...path, "value"),
        step: ref,
        fix: `{"key":"${key}","type":"JSON","value":#{${name}}} (unquoted) and :${key}::jsonb in the SQL.`,
      });
    }
  });
}

// A uuid-looking column (`id`, `*_id`, `*uuid`, optionally qualified) cast to text.
const UUID_COL = String.raw`((?:\w+\.)?(?:id|\w+_id|\w*uuid))`;
const TEXT_CAST = String.raw`\s*::\s*(?:text|varchar|character varying)`;
const BOUND = "__bound__";
const Q6_PATTERNS = [
  new RegExp(String.raw`\b${UUID_COL}${TEXT_CAST}\s*(?:=|<>|!=)\s*${BOUND}`),
  new RegExp(String.raw`${BOUND}(?:${TEXT_CAST})?\s*(?:=|<>|!=)\s*${UUID_COL}${TEXT_CAST}\b`),
  new RegExp(String.raw`\b${UUID_COL}${TEXT_CAST}\s+(?:not\s+)?in\s*\([^)]*${BOUND}`),
];

/**
 * Q6: the column of the first `<uuid-like col>::text = <bound value>` (either
 * side, or `IN (…)`), where a bound value is `'#{…}'`, `#{…}` or `:param`.
 */
function uuidTextComparison(sql: string): string | undefined {
  const bound = replaceSpelBlocks(sql.replace(/'[^']*#\{[^}]*\}[^']*'/g, ` ${BOUND} `), ` ${BOUND} `);
  const skel = sqlSkeleton(bound).toLowerCase().replace(/(?<![:\w]):[a-z_]\w*/g, BOUND).replace(/\s+/g, " ");
  for (const re of Q6_PATTERNS) {
    const m = re.exec(skel);
    if (m) return m[1];
  }
  return undefined;
}

/** The outer SELECT list: text between the first top-level SELECT and its FROM (depth 0); `hasFrom` false when there is none. */
function outerSelectList(lower: string): { list: string; hasFrom: boolean } | undefined {
  const start = /^\s*\(?\s*select\b/.exec(lower);
  if (!start) return undefined;
  let depth = 0;
  for (let i = start[0].length; i < lower.length; i++) {
    const c = lower[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /\bfrom\b/.test(lower.slice(i, i + 5)) && /\W/.test(lower[i - 1] ?? " ")) return { list: lower.slice(start[0].length, i), hasFrom: true };
  }
  return { list: lower.slice(start[0].length), hasFrom: false };
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

/** Paging inputs Report Designer itself sends (not filter columns): exempt from AD-LINT-013. */
const RD_PAGING_INPUTS = new Set(["orderBy", "uniqueKey", "limit", "offset"]);

/** A Report Designer datasource returns `reportColumns` / `reportData` (its RD contract). */
function isReportDatasource(body: Obj): boolean {
  return arr(body.outputs).some((o) => isObj(o) && ["reportColumns", "reportData"].includes(str(o.key) ?? ""));
}

function reportDatasource(body: Obj, steps: unknown[], report: Report): void {
  if (steps.length > 1) {
    report({
      rule: "AD-LINT-011",
      message: `Report Designer datasource has ${steps.length} steps; RD needs exactly one data.read SQL step and otherwise shows only reportColumns/reportData/reportCount as columns.`,
      path: "steps",
      fix: "Move the other logic into the SQL, or into a separate method the report does not use.",
    });
  }
  steps.forEach((s, i) => {
    if (!isObj(s) || stepKind(s) !== "SQL") return;
    const q = findSqlInput(s);
    const raw = q && typeof q.inp.value === "string" ? q.inp.value : "";
    const flagged = q?.inp.encodingType === "BASE_64" || q?.inp.encodedBase64 === true;
    const sql = flagged ? decodeBase64Strict(raw) ?? raw : raw;
    if (sql.trim() && /\s$/.test(sql)) {
      report({
        rule: "AD-LINT-012",
        message: "Report Designer datasource SQL ends with whitespace or a newline; RD then cannot read its column names.",
        path: jsonPath(["steps", i, ...q!.path, "value"]),
        step: stepRef(s, i),
        fix: "Remove the trailing newline (a SQL file usually ends with one).",
      });
    }
  });
  arr(body.inputs).forEach((f, i) => {
    const key = isObj(f) ? str(f.key) ?? "" : "";
    if (key !== key.toLowerCase() && !RD_PAGING_INPUTS.has(key)) {
      report({
        rule: "AD-LINT-013",
        message: `Input "${key}" has upper-case letters; Report Designer filters on column "${key}" are only passed to an input named "${key.toLowerCase()}", so they are ignored.`,
        path: jsonPath(["inputs", i, "key"]),
        fix: `Rename the input to "${key.toLowerCase()}".`,
      });
    }
  });
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
