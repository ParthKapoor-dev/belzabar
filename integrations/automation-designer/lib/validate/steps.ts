// L2 — per-step semantic rules: custom code, SQL, SpEL values, conditions,
// loops, encodings. Everything here looks at one step at a time; rules that
// need other steps (references, uniqueness) live in graph.ts.

import { decodeBase64Strict } from "../base64";
import { jsonPath, stepKind, stepRef, walkInputs, DATA_TYPES } from "./schema";
import { hasSpel, replaceSpelBlocks, scanSpel, stripStrings, type SpelIssue } from "./spel";
import { arr, str, type Report, type StepRef } from "./types";
import { isObj, str as nonBlank } from "@belzabar/core";

const SQL_INPUT_KEYS = new Set(["queryString", "SQLQuery"]);

export function checkSteps(body: Record<string, unknown>, report: Report): void {
  for (const [list, label] of [["inputs", "Method input"], ["variables", "Variable"]] as const) {
    arr(body[list]).forEach((f, i) => {
      if (isObj(f) && hasSpel(f.defaultValue)) {
        report({
          rule: "AD-SPEL-006",
          message: `${label} "${str(f.key) ?? i}" defaultValue ${JSON.stringify(f.defaultValue)} contains #{…}; defaults are stored literally, never evaluated.`,
          path: jsonPath([list, i, "defaultValue"]),
          fix: "Initialise it with an echo step writing the variable instead.",
          evidence: "v2_default_value_spel: stored literally",
        });
      }
    });
  }
  arr(body.steps).forEach((s, i) => {
    if (!isObj(s) || !isObj(s.properties)) return;
    const ref = stepRef(s, i);
    const ctx: StepCtx = { s, props: s.properties, i, ref, report, at: (...rest) => jsonPath(["steps", i, ...rest]) };
    checkInputs(ctx);
    checkConditions(ctx);
    checkLoop(ctx);
    const kind = stepKind(s);
    if (kind === "CUSTOM_CODE") checkCustomCode(ctx);
    if (kind === "SQL") checkSql(ctx);
  });
}

interface StepCtx {
  s: Record<string, unknown>;
  props: Record<string, unknown>;
  i: number;
  ref: StepRef;
  report: Report;
  at: (...rest: Array<string | number>) => string;
}

// ── SpEL in values ────────────────────────────────────────────────────────

const SPEL_ISSUE_RULE: Record<SpelIssue["kind"], string> = {
  unclosed: "AD-SPEL-001",
  nested: "AD-SPEL-002",
  hashVar: "AD-SPEL-003",
  braceLiteral: "AD-SPEL-004",
  syntax: "AD-SPEL-005",
};

function reportSpelIssues(text: string, path: string, where: string, ref: StepRef, report: Report): void {
  for (const issue of scanSpel(text).issues) {
    const rule = SPEL_ISSUE_RULE[issue.kind];
    const what =
      issue.kind === "unclosed" ? "an unclosed #{" :
      issue.kind === "nested" ? "a nested #{ #{…} }" :
      issue.kind === "hashVar" ? "#{#var} (write #{var})" :
      issue.kind === "braceLiteral" ? "an inline {…} literal right after #{" :
      `a SpEL syntax error (${issue.detail})`;
    report({
      rule,
      message: `${where} has ${what}: ${JSON.stringify(issue.text)}.`,
      path,
      step: ref,
      evidence: issue.kind === "unclosed" ? "the literal text becomes the value (v2_spel_unclosed)" : "the step fails and the literal propagates to later steps (v2_spel_*)",
    });
  }
}

function checkInputs(c: StepCtx): void {
  walkInputs(c.s.inputs, ["steps", c.i, "inputs"], (inp, path) => {
    const key = str(inp.key) ?? "?";
    const value = inp.value;
    const flagged = inp.encodingType === "BASE_64" || inp.encodedBase64 === true;
    if (typeof value === "string" && value) {
      const decoded = decodeBase64Strict(value);
      if (flagged && decoded === null) {
        c.report({ rule: "ENC1", message: `Input "${key}" is flagged BASE_64 but its value is not valid base64; the engine will not decode it.`, path: jsonPath([...path, "value"]), step: c.ref, fix: "Base64-encode the value or set encodingType NONE." });
      }
      if (SQL_INPUT_KEYS.has(key) && decoded !== null && !flagged && looksLikeSqlText(decoded)) {
        c.report({ rule: "SQL1", message: `SQL input "${key}" looks base64-encoded but encodingType is not BASE_64; the database would run the encoded text.`, path: jsonPath([...path, "encodingType"]), step: c.ref, fix: "Set encodingType BASE_64, or store the SQL as plain text with NONE.", evidence: "v2_sql_b64_noflag: DB 400 at runtime" });
      }
    }
    const text = typeof value === "string" ? (flagged ? decodeBase64Strict(value) ?? value : value) : undefined;
    if (!text || !hasSpel(text)) return;
    const where = `Input "${key}"`;
    reportSpelIssues(text, jsonPath([...path, "value"]), where, c.ref, c.report);
    if (inp.combineInput === false && scanSpel(text).blocks.length > 0) {
      c.report({
        rule: "CI1",
        message: `${where} holds SpEL (${JSON.stringify(text.slice(0, 40))}) with combineInput:false ('This Exactly', deprecated); the method runs via the API but cannot be run from the AD UI.`,
        path: jsonPath([...path, "combineInput"]),
        step: c.ref,
        fix: "Set combineInput:true on this input.",
      });
    }
    checkSpelComplexity(text, jsonPath([...path, "value"]), where, c);
  });
}

function checkSpelComplexity(text: string, path: string, where: string, c: StepCtx): void {
  for (const b of scanSpel(text).blocks) {
    const body = stripStrings(b.body) ?? b.body;
    // `?[` selection and `?.` safe navigation are not branches.
    const ternaries = (body.match(/\?/g) ?? []).length - (body.match(/\?\[/g) ?? []).length - (body.match(/\?\./g) ?? []).length;
    const operators = (body.match(/[+\-*/]/g) ?? []).length;
    let why: string | undefined;
    if (ternaries >= 2) why = `nests ${ternaries} ternaries`;
    else if (operators > 4) why = `chains ${operators} operators`;
    else if (body.length > 200) why = `is ${body.length} characters long`;
    if (why) {
      c.report({ rule: "SP1", message: `${where} SpEL ${why}; move branching into an entryCondition or separate steps.`, path, step: c.ref });
      return;
    }
  }
}

// ── conditions ────────────────────────────────────────────────────────────

function checkConditions(c: StepCtx): void {
  const entry = isObj(c.props.entryCondition) ? c.props.entryCondition : undefined;
  const exit = isObj(c.props.exitCondition) && isObj(c.props.exitCondition.conditionalExit) ? c.props.exitCondition.conditionalExit : undefined;
  const conds: Array<[Record<string, unknown> | undefined, string[], string]> = [
    [entry, ["properties", "entryCondition"], "Entry condition"],
    [exit, ["properties", "exitCondition", "conditionalExit"], "Conditional exit"],
  ];
  for (const [cond, base, label] of conds) {
    if (!cond) continue;
    const expr = nonBlank(cond.expression);
    const path = c.at(...base, "expression");
    if (!expr) continue;
    if (!expr.includes("#{")) {
      c.report({
        rule: "AD-COND-001",
        message: `${label} ${JSON.stringify(expr.slice(0, 60))} has no #{…}; it compares constants, so the step is silently skipped (or always runs).`,
        path,
        step: c.ref,
        fix: "Reference the value as #{name}, e.g. #{name} eq 'Alex'.",
        evidence: "v2_entry_cond_plain_text: step skipped, run green",
      });
      continue;
    }
    reportSpelIssues(expr, path, label, c.ref, c.report);
    const rows = arr(cond.expandedExpressions).filter(isObj);
    const mismatch = basicRowsMismatch(rows, expr);
    if (mismatch) {
      c.report({
        rule: "AD-COND-002",
        message: `${label} basic rows disagree with the expression (${mismatch}); the runtime uses the expression, the UI shows the rows.`,
        path: c.at(...base, "expandedExpressions"),
        step: c.ref,
        fix: "Rebuild the condition in one mode (clear expandedExpressions for an advanced expression).",
        evidence: "v1_condition_basic_mismatch: step skipped though the rows say it should run",
      });
    }
  }
}

const OPS: Record<string, RegExp> = {
  eq: /\b(eq)\b|==/, ne: /\b(ne)\b|!=/, gt: /\b(gt)\b|>(?!=)/, lt: /\b(lt)\b|<(?!=)/, ge: /\b(ge)\b|>=/, le: /\b(le)\b|<=/,
};

/** A row's field must appear as #{field…} and its operator in the expression. */
function basicRowsMismatch(rows: Array<Record<string, unknown>>, expr: string): string | undefined {
  for (const row of rows) {
    const item = isObj(row.item) ? row.item : undefined;
    const field = nonBlank(item?.fieldCode);
    const op = isObj(row.operator) ? nonBlank(row.operator.value)?.toLowerCase() : undefined;
    if (field && !new RegExp(`#\\{\\s*${escapeRe(field)}\\b`).test(expr)) return `row field "${field}" is not in the expression`;
    if (op && OPS[op] && !OPS[op].test(stripStrings(expr) ?? expr)) return `row operator "${op}" is not in the expression`;
  }
  return undefined;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── loops ─────────────────────────────────────────────────────────────────

const LOOP_COMMON = ["type", "executeParallel", "numberOfConcurrentThread", "counter"];
const LOOP_KEYS: Record<string, string[]> = {
  LOOP_EXECUTION_ON_NUMBER: [...LOOP_COMMON, "value"],
  LOOP_EXECUTION_ON_INPUT_OUTPUT: [...LOOP_COMMON, "value"],
  LOOP_EXECUTION_ON_CONDITION: [...LOOP_COMMON, "value", "expandedExpression"],
  LOOP_EXECUTION_ON_RANGE: [...LOOP_COMMON, "rangeStartInclusive", "rangeEndExclusive", "incrementalCount"],
};
const LOOP_REQUIRED: Record<string, string[]> = {
  LOOP_EXECUTION_ON_NUMBER: ["value"],
  LOOP_EXECUTION_ON_INPUT_OUTPUT: ["value"],
  LOOP_EXECUTION_ON_CONDITION: ["value"],
  LOOP_EXECUTION_ON_RANGE: ["rangeStartInclusive", "rangeEndExclusive"],
};

export function loopConfig(props: Record<string, unknown>): Record<string, unknown> | undefined {
  const rse = props.repeatStepExecution;
  return isObj(rse) && nonBlank(rse.type) ? rse : undefined;
}

function checkLoop(c: StepCtx): void {
  const rse = loopConfig(c.props);
  if (!rse) return;
  const type = str(rse.type)!;
  const at = (k: string) => c.at("properties", "repeatStepExecution", k);
  const allowed = LOOP_KEYS[type];
  if (!allowed) {
    c.report({ rule: "LP1", message: `Loop type "${type}" is not recognised (${Object.keys(LOOP_KEYS).join(", ")}); the server drops an unknown loop.`, path: at("type"), step: c.ref, evidence: "v2_loop_bad_type: repeatStepExecution dropped, no loop" });
    return;
  }
  for (const req of LOOP_REQUIRED[type] ?? []) {
    const v = rse[req];
    if (v === null || v === undefined || (typeof v === "string" && !v.trim())) {
      c.report({ rule: "LP2", message: `Loop ${type} is missing "${req}" (nothing to iterate over).`, path: at(req), step: c.ref, evidence: "v2_loop_io_missing_value: every run 500 getLoopExecutionSource() is null" });
    }
  }
  for (const k of Object.keys(rse)) {
    if (!allowed.includes(k)) c.report({ rule: "LP5", message: `Loop field "${k}" is not recognised for ${type} and is silently ignored (known: ${allowed.join(", ")}).`, path: at(k), step: c.ref });
  }
  const counter = nonBlank(rse.counter);
  if (counter && !/^#\{[^}]+\}$/.test(counter)) {
    c.report({ rule: "LP3", message: `Loop counter ${JSON.stringify(counter)} must be written #{varName}.`, path: at("counter"), step: c.ref, evidence: "v2_loop_number_bare_counter" });
  }
  const value = rse.value;
  if (typeof value === "string" && hasSpel(value)) reportSpelIssues(value, at("value"), "Loop value", c.ref, c.report);
}

// ── custom code ───────────────────────────────────────────────────────────

/** The source as the runtime sees it: strict base64 is decoded (the runtime content-sniffs). */
export function customCodeSource(code: string): string {
  const decoded = decodeBase64Strict(code);
  return decoded !== null && /[\s;(){}=]/.test(decoded) ? decoded : code;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => unknown;

/** Compile-only JS check (the function is never called). */
function jsSyntaxError(source: string): string | undefined {
  const src = replaceSpelBlocks(source, "__belz_spel__");
  try {
    new AsyncFunction(src);
    return undefined;
  } catch (e) {
    return e instanceof SyntaxError ? e.message : undefined;
  }
}

function checkCustomCode(c: StepCtx): void {
  const cc = isObj(c.props.customCode) ? c.props.customCode : {};
  const at = (k: string) => c.at("properties", "customCode", k);
  const lang = cc.language;
  if (lang === null || lang === undefined || lang === "") {
    c.report({ rule: "CC1", message: "Custom code has no language.", path: at("language"), step: c.ref, fix: "Set language JAVASCRIPT (or PYTHON).", evidence: "v2_cc_language_null: runtime NPE at this step" });
  } else if (lang === "JAVA" || lang === "COBOL" || lang === "PERL") {
    c.report({ rule: "CC1", severity: "warn", message: `Custom code language ${lang} is accepted by the server but unsupported by the team tooling (use JAVASCRIPT or PYTHON).`, path: at("language"), step: c.ref });
  }
  if (cc.executor === "NODEJS_LAMBDA") {
    c.report({ rule: "CC5", severity: "warn", message: "Executor NODEJS_LAMBDA is deprecated; use CODE_LAMBDA.", path: at("executor"), step: c.ref });
  }

  const code = str(cc.inlineCode);
  const outputs = arr(c.s.outputs).filter(isObj);
  if (!code || !code.trim()) {
    c.report({ rule: "CC2", message: "Custom code has no inlineCode.", path: at("inlineCode"), step: c.ref });
  } else {
    const source = customCodeSource(code);
    if (lang === "JAVASCRIPT") {
      const err = jsSyntaxError(source);
      if (err) c.report({ rule: "AD-CC-001", message: `JavaScript does not parse: ${err}.`, path: at("inlineCode"), step: c.ref, evidence: "v2_cc_syntax_error: runtime SyntaxError, later steps skipped" });
    }
    const printer = lang === "PYTHON" ? /\bprint\s*\(/ : /\bconsole\.log\s*\(/;
    if ((lang === "JAVASCRIPT" || lang === "PYTHON") && !printer.test(stripComments(source)) && outputs.length > 0) {
      c.report({ rule: "CC3", message: `Custom code never calls ${lang === "PYTHON" ? "print()" : "console.log()"}; the runtime binds outputs from the printed line.`, path: at("inlineCode"), step: c.ref });
    }
    if (outputs.length > 1) {
      const json = lang === "PYTHON" ? /json\.dumps/ : /JSON\.stringify/;
      if (!json.test(source)) {
        c.report({ rule: "CC4", message: `Custom code has ${outputs.length} outputs but never ${lang === "PYTHON" ? "json.dumps()" : "JSON.stringify()"}; multiple outputs need one JSON object printed.`, path: at("inlineCode"), step: c.ref });
      }
    } else if (outputs.length === 1) {
      const etr = nonBlank(outputs[0]!.elementToRetrieve);
      if (etr && !new RegExp(`\\b${escapeRe(etr)}\\b`).test(source)) {
        c.report({ rule: "AD-CC-004", message: `Output elementToRetrieve "${etr}" never appears in the source; the output would stay unbound.`, path: c.at("outputs", 0, "elementToRetrieve"), step: c.ref, evidence: "v2_cc_output_etr_single_wrong: output null" });
      }
    }
  }

  outputs.forEach((o, j) => {
    const op = (k: string) => c.at("outputs", j, k);
    const t = o.type;
    if (typeof t !== "string" || !t) {
      c.report({ rule: "CO1", message: "Custom code output has no type.", path: op("type"), step: c.ref, fix: "Set type (STRING, JSON, ARRAY, BOOLEAN, …)." });
    } else if (!DATA_TYPES.has(t)) {
      c.report({ rule: "CO1", message: `Custom code output type "${t}" is not a known data type.`, path: op("type"), step: c.ref });
    }
    if (!nonBlank(o.name)) c.report({ rule: "CO2", message: "Custom code output has no name.", path: op("name"), step: c.ref });
    if (outputs.length > 1 && !nonBlank(o.elementToRetrieve)) {
      c.report({
        rule: "AD-CC-002",
        message: `Output "${str(o.key) ?? j}" has no elementToRetrieve; with ${outputs.length} outputs the first gets the whole JSON and the rest stay unbound.`,
        path: op("elementToRetrieve"),
        step: c.ref,
        fix: "Set elementToRetrieve to the JSON key this output reads.",
        evidence: "v2_cc_multi_out_no_etr",
      });
    }
    const key = nonBlank(o.key);
    const fc = nonBlank(o.fieldCode);
    if (key && fc && key !== fc) {
      c.report({
        rule: "AD-CC-003",
        message: `Output key "${key}" differs from fieldCode "${fc}"; the server rewrites fieldCode := key, so readers of "${fc}" get null.`,
        path: op("fieldCode"),
        step: c.ref,
        fix: `Set fieldCode (and any #{…} readers) to "${key}".`,
      });
    }
  });
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/^\s*#.*$/gm, "");
}

// ── SQL ───────────────────────────────────────────────────────────────────

function looksLikeSqlText(s: string): boolean {
  return /\b(select|insert|update|delete|with|create|alter|drop)\b/i.test(s);
}

export function findSqlInput(s: Record<string, unknown>): { inp: Record<string, unknown>; path: Array<string | number> } | undefined {
  let found: { inp: Record<string, unknown>; path: Array<string | number> } | undefined;
  walkInputs(s.inputs, ["inputs"], (inp, path) => {
    if (!found && (SQL_INPUT_KEYS.has(str(inp.key) ?? "") || inp.name === "SQLQuery")) found = { inp, path };
  });
  return found;
}

/** Strip comments and literals so keyword/operator checks only see SQL syntax. */
export function sqlSkeleton(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j++; continue; }
          break;
        }
      }
      out += c === "'" ? "''" : '""';
      i = j + 1;
      continue;
    }
    if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      const e = sql.indexOf(tag, i + tag.length);
      out += "''";
      i = e < 0 ? sql.length : e + tag.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const READ_VERBS = new Set(["select", "with", "values", "table", "show", "explain"]);
const OP_VERBS: Record<string, Set<string>> = {
  read: READ_VERBS,
  add: new Set(["insert", "with"]),
  update: new Set(["update", "with", "insert"]),
  delete: new Set(["delete", "with"]),
};

function checkSql(c: StepCtx): void {
  const svc = `${str(c.s.serviceName) ?? ""}/${str(c.s.methodName) ?? ""}`;
  const acct = isObj(c.s.accountConfiguration) ? c.s.accountConfiguration.id : undefined;
  if (acct === null || acct === undefined || acct === "") {
    c.report({ rule: "AD-SQL-002", message: `SQL step (${svc}) has no accountConfiguration.id.`, path: c.at("accountConfiguration"), step: c.ref, fix: "Copy accountConfiguration {id, name} from a working SQL step (see `wi-impl ad sql` databases).", evidence: "v2_sql_no_account: runtime 'Failed to execute automation!'" });
  }
  const q = findSqlInput(c.s);
  const raw = q && typeof q.inp.value === "string" ? q.inp.value : "";
  if (!raw.trim()) {
    c.report({ rule: "AD-SQL-001", message: `SQL step (${svc}) has no queryString.`, path: q ? c.at(...q.path, "value") : c.at("inputs"), step: c.ref });
    return;
  }
  const flagged = q!.inp.encodingType === "BASE_64" || q!.inp.encodedBase64 === true;
  const sql = flagged ? decodeBase64Strict(raw) ?? raw : raw;
  const path = c.at(...q!.path, "value");
  // SpEL blocks are substituted before the DB sees the text: blank them for the lint.
  const withoutSpel = replaceSpelBlocks(sql, "0");
  const skel = sqlSkeleton(withoutSpel);

  const op = /data\.(read|add|update|delete)$/.exec(str(c.s.methodName) ?? "")?.[1];
  const verb = /^\s*\(?\s*([A-Za-z]+)/.exec(skel)?.[1]?.toLowerCase();
  if (op && verb && OP_VERBS[op] && !OP_VERBS[op]!.has(verb)) {
    c.report({ rule: "AD-SQL-003", message: `SQL starts with ${verb.toUpperCase()} but the step is db_service/data.${op}.`, path, step: c.ref, fix: `Use the data.${READ_VERBS.has(verb) ? "read" : verb === "insert" ? "add" : verb} service for this statement.` });
  }
  if (/\?/.test(skel)) {
    c.report({ rule: "Q1", message: "SQL contains a bare '?' (jsonb ?, ?|, ?&); platform-executed SQL treats it as a bind parameter and fails.", path, step: c.ref, fix: "Use @> (e.g. col @> '[\"x\"]'::jsonb) or jsonb_exists(col, 'x').", evidence: "given N parameters but expected 0" });
  }
  if (/[‘’“”]/.test(skel) || /-»/.test(skel)) {
    c.report({ rule: "Q5", message: "SQL contains autoformat damage outside a string literal (curly quotes or '-»' for '->>').", path, step: c.ref, fix: "Retype the quotes as ' and the operator as ->>." });
  } else if (/[–—]/.test(skel)) {
    c.report({ rule: "Q5", severity: "warn", message: "SQL contains an en/em dash outside a string literal (autoformatted '--'?).", path, step: c.ref });
  }
  if (scanSpel(sql).blocks.length > 0) {
    c.report({ rule: "AD-SQL-004", message: "#{…} is spliced into the SQL text; values are not escaped or typed.", path, step: c.ref, fix: "Use :name placeholders with body.queryParams [{key, value, type}]." });
  }
}
