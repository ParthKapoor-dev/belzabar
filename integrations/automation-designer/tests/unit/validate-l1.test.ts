// lib/validate L1 — structural rules over the V2 wire body. One positive and
// one negative case per rule; live cases (tests/fixtures/validate/cases.json)
// where the research reproduced the server's answer.

import { describe, expect, test } from "bun:test";
import { validateMethodV2, type ValidationResult } from "../../lib/validate/index";
import { caseBody, golden, mutate } from "./validate-fixtures";

const all = (r: ValidationResult) => [...r.errors, ...r.warnings];
const rules = (body: unknown) => all(validateMethodV2({ after: body as never })).map((f) => `${f.rule}:${f.severity}`);
const has = (body: unknown, rule: string, severity: "error" | "warn" = "error") => rules(body).includes(`${rule}:${severity}`);

describe("L1 golden baseline", () => {
  test("the research baseline (echo, custom code, SQL) has no L1 finding", () => {
    const r = validateMethodV2({ after: golden() });
    expect(r.layersRun).toEqual(["L1", "L2", "L3"]);
    expect(all(r).filter((f) => f.rule.startsWith("AD-SCHEMA") || /^(M1|M2|IK1|VK1|OK1|ON1|S1|S2|NC1|EI1|EI2|ES1|ES2)$/.test(f.rule))).toEqual([]);
  });
});

describe("L1 rules", () => {
  const table: Array<{ rule: string; severity?: "error" | "warn"; bad: () => unknown; good: () => unknown; why: string }> = [
    { rule: "AD-SCHEMA-001", why: "body not an object", bad: () => [], good: golden },
    { rule: "AD-SCHEMA-001", why: "exitOnFailure.value 'yes' (v2_exit_on_failure_str, 400)", bad: () => caseBody("v2_exit_on_failure_str"), good: golden },
    { rule: "AD-SCHEMA-001", why: "inputReference '' (v2_var_ref_emptystr, 400)", bad: () => caseBody("v2_var_ref_emptystr"), good: golden },
    { rule: "AD-SCHEMA-002", why: "method output type FOO (v2_output_type_invalid, 500)", bad: () => caseBody("v2_output_type_invalid"), good: golden },
    { rule: "AD-SCHEMA-002", why: "method input type FOO (v2_input_type_invalid, 500)", bad: () => caseBody("v2_input_type_invalid"), good: golden },
    { rule: "AD-SCHEMA-003", severity: "warn", why: "non-hex io uuid (real …6a00e5g)", bad: () => mutate((m) => { m.steps[0].outputs[0].uuid = "5b11494a-c244-47a9-a063-3434f6a00e5g"; }), good: golden },
    { rule: "AD-META-001", why: "state PUBLISHED in body (v2_state_published_in_body, 400)", bad: () => caseBody("v2_state_published_in_body"), good: golden },
    { rule: "AD-META-002", why: "thin update (v2_thin_update, 400 Invalid state)", bad: () => caseBody("v2_thin_update"), good: golden },
    { rule: "M1", why: "name with a space (v2_method_name_space, 400)", bad: () => caseBody("v2_method_name_space"), good: golden },
    { rule: "M1", why: "leading dot", bad: () => mutate((m) => { m.name = ".foo"; }), good: () => mutate((m) => { m.name = "F3b-g5~x.y_z"; }) },
    { rule: "M1", why: "trailing dot", bad: () => mutate((m) => { m.name = "foo."; }), good: () => mutate((m) => { m.name = "Helpers_x.echo2"; }) },
    { rule: "M1", why: "missing name", bad: () => mutate((m) => { delete m.name; }), good: golden },
    { rule: "M2", why: "V1 body", bad: () => ({ name: "x", services: [] }), good: golden },
    { rule: "M2", why: "no steps", bad: () => mutate((m) => { delete m.steps; }), good: golden },
    { rule: "IK1", why: "input key na-me (v2_input_key_hyphen, 400)", bad: () => caseBody("v2_input_key_hyphen"), good: () => mutate((m) => { m.inputs[0].key = "ok_key"; }) },
    { rule: "IK1", why: "input key with a dot", bad: () => mutate((m) => { m.inputs[0].key = "bad.key"; }), good: golden },
    { rule: "VK1", why: "variable key greet.ing (v2_var_key_dot, 400)", bad: () => caseBody("v2_var_key_dot"), good: () => mutate((m) => { m.variables[0].key = "ok_var"; }) },
    { rule: "OK1", why: "method output without key (v2_method_output_nokey, run NPE)", bad: () => caseBody("v2_method_output_nokey"), good: golden },
    { rule: "OK1", why: "method output key with a space", bad: () => mutate((m) => { m.outputs[0].key = "bad key"; }), good: golden },
    { rule: "ON1", why: "method output name with a space", bad: () => mutate((m) => { m.outputs[0].name = "Echoed message"; }), good: () => mutate((m) => { m.outputs[0].name = "Greeting"; }) },
    { rule: "S1", why: "step without properties (v2_step_no_properties, 500 NPE)", bad: () => caseBody("v2_step_no_properties"), good: golden },
    { rule: "S1", why: "properties.type FOO (v2_step_type_invalid, 400)", bad: () => caseBody("v2_step_type_invalid"), good: golden },
    { rule: "S2", severity: "warn", why: "step id not a uuid", bad: () => mutate((m) => { m.steps[0].id = "step-1"; }), good: golden },
    { rule: "NC1", why: "step output name with a space (v2_out_name_space, 400)", bad: () => caseBody("v2_out_name_space"), good: golden },
    { rule: "NC1", why: "fieldCode with a dot", bad: () => mutate((m) => { m.steps[2].outputs[0].fieldCode = "ok.code"; }), good: () => mutate((m) => { m.steps[2].outputs[0].fieldCode = "ok_code"; }) },
    { rule: "AD-OUT-001", why: "step output fieldCode '' (v2_out_fieldcode_empty, 400)", bad: () => mutate((m) => { m.steps[2].outputs[0].fieldCode = ""; }), good: golden },
    { rule: "AD-OUT-001", why: "step output fieldCode null (v2_out_fieldcode_null, 500)", bad: () => mutate((m) => { m.steps[2].outputs[0].fieldCode = null; }), good: golden },
    { rule: "AD-OUT-002", why: "step output without key", bad: () => mutate((m) => { delete m.steps[2].outputs[0].key; }), good: golden },
    { rule: "EI1", why: "step input without key", bad: () => mutate((m) => { delete m.steps[0].inputs[0].key; }), good: golden },
    { rule: "EI2", severity: "warn", why: "step input type BLOB", bad: () => mutate((m) => { m.steps[0].inputs[0].type = "BLOB"; }), good: () => mutate((m) => { m.steps[0].inputs[0].type = "ENUM"; }) },
    { rule: "ES1", why: "no automationAPIId and no names", bad: () => mutate((m) => { delete m.steps[0].automationAPIId; delete m.steps[0].serviceName; }), good: () => caseBody("v2_apiid_removed_names_ok") },
    { rule: "ES2", severity: "warn", why: "automationAPIId not a uuid", bad: () => mutate((m) => { m.steps[0].automationAPIId = "echo"; }), good: () => caseBody("v2_apiid_trimmed") },
    { rule: "CC1", why: "language TYPESCRIPT (v2_cc_language_bad, 400)", bad: () => caseBody("v2_cc_language_bad"), good: golden },
    { rule: "CC5", why: "executor NOPE (v2_cc_executor_bad, 400)", bad: () => caseBody("v2_cc_executor_bad"), good: golden },
  ];
  for (const row of table) {
    test(`${row.rule} ${row.why}`, () => {
      expect(has(row.bad(), row.rule, row.severity ?? "error")).toBe(true);
      expect(rules(row.good()).some((r) => r.startsWith(`${row.rule}:`))).toBe(false);
    });
  }

  test("findings carry path and 1-based step ref", () => {
    const r = validateMethodV2({ after: caseBody("v2_out_name_space") });
    const f = r.errors.find((e) => e.rule === "NC1")!;
    expect(f.path).toBe("steps[0].outputs[0].name");
    expect(f.step).toEqual({ orderIndex: 1, kind: "SPEL_ECHO", service: "Helpers.Legacy/echo" });
    expect(f.evidence).toContain("invalid_step_output_name");
  });
});
