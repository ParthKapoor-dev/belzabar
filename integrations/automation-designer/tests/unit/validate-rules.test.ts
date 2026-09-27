// lib/validate L2 (per step) and L3 (graph): one positive and one negative
// case per rule, using the live research cases where one exists
// (tests/fixtures/validate/cases.json; `observed` holds the server/runtime result).

import { describe, expect, test } from "bun:test";
import { encodeBase64 } from "../../lib/base64";
import { validateMethodV2, type ValidationResult } from "../../lib/validate/index";
import { caseBody, golden, mutate } from "./validate-fixtures";

const all = (r: ValidationResult) => [...r.errors, ...r.warnings];
const found = (body: unknown) => all(validateMethodV2({ after: body as never }));
const has = (body: unknown, rule: string, severity: "error" | "warn") => found(body).some((f) => f.rule === rule && f.severity === severity);
const hasRule = (body: unknown, rule: string) => found(body).some((f) => f.rule === rule);

describe("golden baseline", () => {
  test("only the spliced-SQL warning (select … '#{name}')", () => {
    const r = validateMethodV2({ after: golden() });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.rule)).toEqual(["AD-SQL-004"]);
  });
  test("the live no-op case is clean too", () => {
    expect(validateMethodV2({ after: caseBody("v2_noop") }).errors).toEqual([]);
  });
});

type Row = { rule: string; severity: "error" | "warn"; why: string; bad: () => unknown; good: () => unknown };

const cc = (code: string, outputs?: unknown[]) =>
  mutate((m) => {
    m.steps[1].properties.customCode.inlineCode = code;
    if (outputs) m.steps[1].outputs = outputs;
  });
// `any`: the mutator reaches into the raw (possibly malformed) wire input.
const sql = (text: string, mut?: (q: any) => void) =>
  mutate((m) => {
    const q = m.steps[2].inputs[0].properties[0];
    q.value = text;
    mut?.(q);
  });
const echo = (value: string, combineInput = true) =>
  mutate((m) => {
    m.steps[0].inputs[0].value = value;
    m.steps[0].inputs[0].combineInput = combineInput;
  });
const entry = (expression: string, rows: unknown[] | null = null) =>
  mutate((m) => {
    m.steps[0].properties.entryCondition = { expression, expandedExpressions: rows };
  });
const loop = (rse: unknown, withIdx = true) =>
  mutate((m) => {
    m.steps[0].properties.repeatStepExecution = rse;
    if (withIdx) m.variables.push({ key: "idx", name: "idx", type: "TEXT", required: false, properties: [], encodingType: "NONE" });
    m.inputs.push({ key: "items", name: "items", type: "JSON", required: false, properties: [], encodingType: "NONE" });
  });
const row = (fieldCode: string, op: string) => ({ item: { fieldCode, category: "Input" }, value: "Parth", operator: { value: op }, groupOp: null, ignoreCase: false });

const L2: Row[] = [
  // custom code
  { rule: "CC1", severity: "error", why: "language null (v2_cc_language_null: runtime NPE)", bad: () => caseBody("v2_cc_language_null"), good: golden },
  { rule: "CC1", severity: "warn", why: "language JAVA (in enum, unsupported)", bad: () => mutate((m) => { m.steps[1].properties.customCode.language = "JAVA"; }), good: golden },
  { rule: "CC2", severity: "error", why: "inlineCode blank", bad: () => cc("  "), good: golden },
  { rule: "CC3", severity: "warn", why: "code never prints", bad: () => cc("const g = 1;"), good: () => cc("if (1) {\n  console.log('x')\n}") },
  { rule: "CC4", severity: "error", why: "two outputs, no JSON.stringify", bad: () => cc("console.log(1)", [{ key: "a", fieldCode: "a", name: "a", type: "TEXT", elementToRetrieve: "a" }, { key: "b", fieldCode: "b", name: "b", type: "TEXT", elementToRetrieve: "b" }]), good: () => caseBody("v2_cc_multi_out_with_etr") },
  { rule: "CC5", severity: "warn", why: "NODEJS_LAMBDA deprecated", bad: () => mutate((m) => { m.steps[1].properties.customCode.executor = "NODEJS_LAMBDA"; }), good: golden },
  { rule: "CO1", severity: "error", why: "output without type (v2_cc_output_no_type)", bad: () => caseBody("v2_cc_output_no_type"), good: golden },
  { rule: "CO1", severity: "error", why: "output type STRIING (seen on sems-dev)", bad: () => mutate((m) => { m.steps[1].outputs[0].type = "STRIING"; }), good: golden },
  { rule: "CO2", severity: "error", why: "output without name", bad: () => mutate((m) => { m.steps[1].outputs[0].name = ""; }), good: golden },
  { rule: "AD-CC-001", severity: "error", why: "JS syntax error (v2_cc_syntax_error: runtime SyntaxError)", bad: () => caseBody("v2_cc_syntax_error"), good: () => caseBody("v2_cc_hash_brace_literal") },
  { rule: "AD-CC-001", severity: "error", why: "syntax error inside base64 code", bad: () => cc(encodeBase64("const g = ;\nconsole.log(g)")), good: () => caseBody("v2_cc_inline_b64") },
  { rule: "AD-CC-002", severity: "error", why: "multi output without elementToRetrieve (v2_cc_multi_out_no_etr)", bad: () => caseBody("v2_cc_multi_out_no_etr"), good: () => caseBody("v2_cc_multi_out_with_etr") },
  { rule: "AD-CC-003", severity: "error", why: "output key != fieldCode (server rewrites fieldCode := key)", bad: () => mutate((m) => { m.steps[1].outputs[0].key = "ccOther"; }), good: golden },
  { rule: "AD-CC-004", severity: "warn", why: "single etr never printed (v2_cc_output_etr_single_wrong)", bad: () => caseBody("v2_cc_output_etr_single_wrong"), good: () => cc("console.log(JSON.stringify({result: 1}))", [{ key: "ccOut", fieldCode: "ccOut", name: "ccOut", type: "TEXT", elementToRetrieve: "result" }]) },
  // SQL + encodings
  { rule: "SQL1", severity: "error", why: "base64 SQL without flag (v2_sql_b64_noflag: DB 400)", bad: () => caseBody("v2_sql_b64_noflag"), good: () => caseBody("v2_sql_b64_flagged") },
  { rule: "ENC1", severity: "warn", why: "BASE_64 flag on plain text (v2_sql_flag_plain: ignored)", bad: () => caseBody("v2_sql_flag_plain"), good: () => caseBody("v2_sql_b64_flagged") },
  { rule: "AD-SQL-001", severity: "error", why: "empty queryString", bad: () => sql(""), good: golden },
  { rule: "AD-SQL-002", severity: "error", why: "no accountConfiguration (v2_sql_no_account)", bad: () => caseBody("v2_sql_no_account"), good: golden },
  { rule: "AD-SQL-003", severity: "warn", why: "UPDATE in data.read", bad: () => sql("update t set a = 1"), good: () => sql("with x as (select 1) select * from x") },
  { rule: "AD-SQL-004", severity: "warn", why: "#{…} spliced into SQL", bad: golden, good: () => sql("select 1 as one, :nm as nm") },
  { rule: "Q1", severity: "error", why: "bare jsonb ? operator", bad: () => sql("select * from t where tags ? 'x'"), good: () => sql("select * from t where tags @> '[\"x\"]'::jsonb and note = 'why?' -- really?") },
  { rule: "Q5", severity: "error", why: "curly quotes as SQL quotes", bad: () => sql("select * from t where code=’A’"), good: () => sql("select 'it’s' as t") },
  { rule: "Q5", severity: "error", why: "-» for ->>", bad: () => sql("select data-»'a' from t"), good: () => sql("select data->>'a' from t") },
  { rule: "Q5", severity: "warn", why: "en dash comment", bad: () => sql("select 1 –– note"), good: () => sql("select 1 -- note – fine") },
  // SpEL values
  { rule: "CI1", severity: "error", why: "SpEL with combineInput:false (v2_combineInput_false_spel)", bad: () => caseBody("v2_combineInput_false_spel"), good: () => echo("hello", false) },
  { rule: "CI1", severity: "error", why: "nested body sub-property with combineInput:false", bad: () => sql("select '#{name}'", (q) => { q.combineInput = false; }), good: () => sql("select 1", (q) => { q.combineInput = false; }) },
  { rule: "SP1", severity: "warn", why: "nested ternary", bad: () => echo("#{name == 'a' ? 'A' : name == 'b' ? 'B' : 'C'}"), good: () => echo("#{name == 'a' ? 'A' : 'B'}") },
  { rule: "SP1", severity: "warn", why: "chained operators", bad: () => echo("#{name + 1 - 2 * 3 / 4 + 5}"), good: () => echo("#{T(java.lang.Integer).parseInt(name) + T(java.lang.Integer).parseInt(name)}") },
  { rule: "AD-SPEL-001", severity: "error", why: "unclosed (v2_spel_unclosed: literal becomes the value)", bad: () => caseBody("v2_spel_unclosed"), good: golden },
  { rule: "AD-SPEL-002", severity: "error", why: "nested (v2_spel_nested)", bad: () => caseBody("v2_spel_nested"), good: golden },
  { rule: "AD-SPEL-003", severity: "error", why: "#{#var}", bad: () => echo("Hello #{#name}"), good: golden },
  { rule: "AD-SPEL-004", severity: "error", why: "brace literal (v2_spel_brace_literal)", bad: () => caseBody("v2_spel_brace_literal"), good: () => echo("#{name.length() > 1 ? '{' : '}'}") },
  { rule: "AD-SPEL-005", severity: "error", why: "trailing operator (v2_spel_syntax_error)", bad: () => caseBody("v2_spel_syntax_error"), good: golden },
  { rule: "AD-SPEL-005", severity: "error", why: "entry condition syntax (v2_entry_cond_syntax)", bad: () => caseBody("v2_entry_cond_syntax"), good: () => entry("#{name} eq 'x'") },
  { rule: "AD-SPEL-005", severity: "error", why: "unbalanced parentheses", bad: () => echo("#{name.substring(0, 1}"), good: () => echo("#{name.substring(0, 1)}") },
  { rule: "AD-SPEL-006", severity: "warn", why: "defaultValue SpEL (v2_default_value_spel)", bad: () => caseBody("v2_default_value_spel"), good: golden },
  // conditions
  { rule: "AD-COND-001", severity: "error", why: "no #{} (v2_entry_cond_plain_text: silently skipped)", bad: () => caseBody("v2_entry_cond_plain_text"), good: () => entry("#{name} eq 'Parth'") },
  { rule: "AD-COND-002", severity: "warn", why: "basic rows say eq, expression says ne (v1_condition_basic_mismatch)", bad: () => entry("#{name} ne 'Parth'", [row("name", "eq")]), good: () => entry("#{name} eq 'Parth'", [row("name", "eq")]) },
  { rule: "AD-COND-002", severity: "warn", why: "row field not in expression", bad: () => entry("#{greeting} eq 'x'", [row("name", "eq")]), good: () => entry("#{name} eq 'x'", [row("name", "eq")]) },
  // loops (team LP golden set is ported in validate-team.test.ts)
  { rule: "LP1", severity: "warn", why: "unknown loop type (v2_loop_bad_type: loop dropped)", bad: () => caseBody("v2_loop_bad_type"), good: () => loop({ type: "LOOP_EXECUTION_ON_NUMBER", value: "3", counter: "#{idx}" }) },
  { rule: "LP2", severity: "error", why: "ON_INPUT_OUTPUT without value (v2_loop_io_missing_value: every run 500)", bad: () => caseBody("v2_loop_io_missing_value"), good: () => loop({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{items}" }) },
  { rule: "LP3", severity: "error", why: "bare counter (v2_loop_number_bare_counter)", bad: () => caseBody("v2_loop_number_bare_counter"), good: () => loop({ type: "LOOP_EXECUTION_ON_NUMBER", value: "3", counter: "#{idx}" }) },
  { rule: "LP5", severity: "warn", why: "loopVariable field", bad: () => loop({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{items}", loopVariable: "x" }), good: () => loop({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{items}", counter: null, executeParallel: false, numberOfConcurrentThread: null }) },
];

const L3: Row[] = [
  { rule: "LP4", severity: "error", why: "counter variable undeclared", bad: () => loop({ type: "LOOP_EXECUTION_ON_NUMBER", value: "3", counter: "#{idx}" }, false), good: () => loop({ type: "LOOP_EXECUTION_ON_NUMBER", value: "3", counter: "#{idx}" }) },
  { rule: "LP6", severity: "warn", why: "loop value reads nothing defined", bad: () => loop({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{nothing}" }), good: () => loop({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{items}" }) },
  { rule: "CR1", severity: "error", why: "entry condition undeclared (v2_entry_cond_undeclared: skipped, run green)", bad: () => caseBody("v2_entry_cond_undeclared"), good: () => entry("#{name} eq 'x' and #{serviceSuccess3_5} eq true") },
  { rule: "CR1", severity: "error", why: "conditional exit reads an unknown name", bad: () => mutate((m) => { m.steps[0].properties.exitCondition.conditionalExit.expression = "#{ghost} eq 1"; }), good: () => mutate((m) => { m.steps[0].properties.exitCondition.conditionalExit.expression = "#{greetingOut} eq 'x'"; }) },
  { rule: "AD-REF-001", severity: "error", why: "dangling #{nmae} (v2_spel_dangling_ref)", bad: () => caseBody("v2_spel_dangling_ref"), good: () => echo("#{LoggedInUser.id} #{util.now()} #{name.?[x > 1]} #{T(java.lang.Math).max(1, 2)}") },
  { rule: "AD-REF-001", severity: "error", why: "input renamed, steps still read #{name} (v2_input_key_renamed_dangling)", bad: () => caseBody("v2_input_key_renamed_dangling"), good: golden },
  { rule: "AD-REF-001", severity: "error", why: "custom code reads an unknown name", bad: () => cc("console.log('#{ghost}')"), good: golden },
  { rule: "AD-REF-002", severity: "warn", why: "reader before writer (v2_step_reorder)", bad: () => caseBody("v2_step_reorder"), good: golden },
  { rule: "SV1", severity: "error", why: "inputReference to undeclared variable (v2_var_undeclared_ref: write lost)", bad: () => caseBody("v2_var_undeclared_ref"), good: golden },
  { rule: "VB1", severity: "error", why: "variable-writing output with empty name", bad: () => mutate((m) => { m.steps[0].outputs[0].name = ""; }), good: () => mutate((m) => { m.steps[0].outputs[0].name = "greeting"; m.steps[0].outputs[0].fieldCode = "greeting"; m.outputs[0].key = "greeting"; }) },
  { rule: "M3", severity: "error", why: "method output nothing writes (v2_method_output_unbound: null)", bad: () => caseBody("v2_method_output_unbound"), good: golden },
  { rule: "S3", severity: "error", why: "duplicate step id (v2_dup_step_id: outputs dropped)", bad: () => caseBody("v2_dup_step_id"), good: golden },
  { rule: "DUP1", severity: "error", why: "duplicate fieldCode (v2_dup_out_fieldcode: other output null)", bad: () => caseBody("v2_dup_out_fieldcode"), good: golden },
  { rule: "AD-GRAPH-001", severity: "error", why: "duplicate input key (v2_dup_input_keys)", bad: () => caseBody("v2_dup_input_keys"), good: golden },
  { rule: "AD-GRAPH-002", severity: "error", why: "variable key == input key (v2_dup_variable_input_same_key)", bad: () => caseBody("v2_dup_variable_input_same_key"), good: golden },
  { rule: "AD-GRAPH-003", severity: "error", why: "outputRef index 9 of 3 (v2_outputref_bad_index: 500)", bad: () => caseBody("v2_outputref_bad_index"), good: golden },
  { rule: "AD-GRAPH-004", severity: "warn", why: "outputRef points forward", bad: () => mutate((m) => { m.steps[2].inputs[0].properties[0].outputRef = { referenceStepIndex: 2 }; }), good: () => mutate((m) => { m.steps[2].inputs[0].properties[0].outputRef = { referenceStepIndex: 0 }; }) },
  { rule: "AD-GRAPH-005", severity: "warn", why: "step after unconditional exception.raise", bad: () => mutate((m) => { m.steps[0].serviceName = "Helpers.Legacy"; m.steps[0].methodName = "exception.raise"; }), good: () => mutate((m) => { m.steps[0].methodName = "exception.raise"; m.steps[0].properties.entryCondition.expression = "#{name} eq null"; }) },
  { rule: "AD-GRAPH-006", severity: "warn", why: "empty steps (v2_empty_steps: outputs null)", bad: () => caseBody("v2_empty_steps"), good: golden },
  { rule: "AS1", severity: "error", why: "runAsync writes a method output (v2_runasync_output)", bad: () => caseBody("v2_runasync_output"), good: () => mutate((m) => { m.steps[0].properties.runAsync = true; m.steps[0].outputs = []; m.outputs.shift(); }) },
];

describe.each([["L2", L2], ["L3", L3]] as const)("%s rules", (_layer, rows) => {
  for (const r of rows) {
    test(`${r.rule} ${r.severity}: ${r.why}`, () => {
      expect(has(r.bad(), r.rule, r.severity)).toBe(true);
      expect(hasRule(r.good(), r.rule)).toBe(false);
    });
  }
});
