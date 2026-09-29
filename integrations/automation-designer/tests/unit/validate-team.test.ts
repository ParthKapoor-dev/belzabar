// Ports of the team validator's tests (expertly.coding.agents …/ad/scripts/tests/
// test_validate_{ci1,as1,lp,sp1,vb1,nc1_dup1,ok1_on1,g4g5g6}.py) with their inline
// fixtures, so the shared rule codes keep the team's meaning.
// Deliberate differences (catalogue.ts): CI1 and DUP1 are warnings (they
// fire on 58 / 5 spots of working real acme-dev methods); the rest keep their severity.

import { describe, expect, test } from "bun:test";
import { validateMethodV2 } from "../../lib/validate/index";

type M = Record<string, unknown>;
const run = (m: M) => validateMethodV2({ after: m as never });
const errs = (m: M, code: string) => run(m).errors.filter((e) => e.rule === code);
const warns = (m: M, code: string) => run(m).warnings.filter((w) => w.rule === code);
const fires = (m: M, code: string) => errs(m, code).length > 0;
const firesAny = (m: M, code: string) => fires(m, code) || warns(m, code).length > 0;

const SIMPLE_ECHO: M = {
  name: "SimpleEcho",
  inputs: [{ key: "message", name: "message", type: "STRING" }],
  outputs: [],
  variables: [],
  steps: [{ serviceName: "Helpers.String", methodName: "echo", properties: { type: "EXISTING_SERVICE" }, inputs: [{ key: "input", value: "#{message}", type: "STRING" }], outputs: [{ key: "response", name: "echoResponse", fieldCode: "echoResponse" }] }],
};

describe("golden SimpleEcho (team fixtures/simple_echo_method.json)", () => {
  test("no errors, no warnings", () => {
    const r = run(SIMPLE_ECHO);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("CI1 (test_validate_ci1.py)", () => {
  const method = (stepInputs: unknown[]): M => ({
    name: "CIProbe", inputs: [{ key: "msg", name: "msg", type: "STRING" }], outputs: [{ key: "outv", name: "outv", type: "TEXT" }], variables: [],
    steps: [{ serviceName: "Helpers.String", methodName: "echo", properties: { type: "EXISTING_SERVICE" }, inputs: stepInputs, outputs: [{ key: "response", name: "outv", fieldCode: "outv" }] }],
  });
  const flat = (value: unknown, combine: boolean | null) => ({ key: "input", value, type: "STRING", ...(combine === null ? {} : { combineInput: combine }) });
  const nested = (value: unknown, combine: boolean | null) => ({ key: "body", name: "", type: "OBJECT", combineInput: false, properties: [{ key: "json", name: "inputJSON", value, type: "JSON", ...(combine === null ? {} : { combineInput: combine }) }] });
  const cases: Array<[string, unknown, boolean]> = [
    ["flat SpEL + false", flat("#{msg}", false), true],
    ["SpEL embedded in literal", flat("[#{msg},#{msg}]", false), true],
    ["expression SpEL", flat("#{'Hello, ' + msg}", false), true],
    ["nested body sub-property", nested("#{msg}", false), true],
    ["SpEL + true", flat("#{msg}", true), false],
    ["nested SpEL + true", nested("#{msg}", true), false],
    ["plain literal + false", flat("hello", false), false],
    ["JSON-path literal", flat("$.city", false), false],
    ["empty value", flat("", false), false],
    ["non-string value", { key: "input", value: 42, combineInput: false }, false],
    ["SpEL with flag absent", flat("#{msg}", null), false],
    ["nested SpEL with flag absent", nested("#{msg}", null), false],
  ];
  for (const [label, inp, want] of cases) test(`${want ? "fires" : "silent"}: ${label}`, () => expect(firesAny(method([inp]), "CI1")).toBe(want));
  test("is a warning naming combineInput and the UI", () => {
    const w = warns(method([flat("#{msg}", false)]), "CI1")[0]!;
    expect(w.message).toContain("combineInput");
    expect(w.message).toContain("UI");
    expect(errs(method([flat("#{msg}", false)]), "CI1")).toEqual([]);
  });
});

describe("AS1 (test_validate_as1.py)", () => {
  const bad: M = {
    name: "AsyncOutputBad", inputs: [{ key: "value", name: "value", type: "STRING" }], outputs: [{ key: "result", name: "Result", type: "STRING" }], variables: [],
    steps: [{ serviceName: "Helpers.Legacy", methodName: "echo", properties: { type: "EXISTING_SERVICE", runAsync: true }, inputs: [{ key: "value", type: "STRING" }], outputs: [{ key: "response", fieldCode: "result", name: "result", type: "STRING" }] }],
  };
  const good: M = {
    ...bad,
    name: "AsyncOutputGood",
    steps: [
      { serviceName: "Helpers.Legacy", methodName: "echo", properties: { type: "EXISTING_SERVICE", runAsync: false }, inputs: [{ key: "value", type: "STRING" }], outputs: [{ key: "response", fieldCode: "result", name: "result", type: "STRING" }] },
      { serviceName: "Expertly.Notification", methodName: "notify", properties: { type: "EXISTING_SERVICE", runAsync: true }, inputs: [{ key: "msg", type: "STRING" }], outputs: [] },
    ],
  };
  test("async → method output fires", () => expect(fires(bad, "AS1")).toBe(true));
  test("sync output + side-effect async is silent", () => expect(fires(good, "AS1")).toBe(false));
});

describe("LP1–LP6 (test_validate_lp.py)", () => {
  const method = (rse: unknown, { counterVar = true, valueInput = true } = {}): M => ({
    name: "LoopCase",
    inputs: valueInput ? [{ key: "items", name: "items", type: "JSON", description: "array", defaultValue: "[]" }] : [],
    outputs: [],
    variables: counterVar ? [{ key: "idx", name: "idx", type: "TEXT", required: false, properties: [], reference: "", encodingType: "NONE" }] : [],
    steps: [{ serviceName: "Helpers.Legacy", methodName: "echo", properties: { type: "EXISTING_SERVICE", repeatStepExecution: rse }, inputs: [{ key: "input", value: "#{items.element}", type: "STRING" }], outputs: [{ key: "response", name: "r", fieldCode: "r" }] }],
  });
  const lp = (m: M) => [...run(m).errors, ...run(m).warnings].filter((f) => f.rule.startsWith("LP"));
  const GOLDEN = [
    { type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{items}", counter: "", executeParallel: false, numberOfConcurrentThread: 5 },
    { type: "LOOP_EXECUTION_ON_NUMBER", value: "3", counter: "#{idx}", executeParallel: false, numberOfConcurrentThread: 1 },
    { type: "LOOP_EXECUTION_ON_CONDITION", value: "#{idx == '3'}", counter: "#{idx}", executeParallel: false, numberOfConcurrentThread: 1, expandedExpression: "..." },
    { type: "LOOP_EXECUTION_ON_RANGE", counter: "#{idx}", rangeStartInclusive: "0", rangeEndExclusive: "#{items}", incrementalCount: "1", executeParallel: false },
  ];
  GOLDEN.forEach((rse, i) => test(`golden[${i}] ${rse.type} clean`, () => expect(lp(method(rse))).toEqual([])));
  test("LP1 unknown type is a warning", () => {
    const m = method({ type: "LOOP_EXECUTION_BOGUS", value: "#{items}" });
    expect(warns(m, "LP1").length).toBe(1);
    expect(errs(m, "LP1")).toEqual([]);
  });
  test("LP2 missing value", () => expect(fires(method({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", executeParallel: false }), "LP2")).toBe(true));
  test("LP3 plain counter", () => expect(fires(method({ type: "LOOP_EXECUTION_ON_NUMBER", value: "3", counter: "idx" }), "LP3")).toBe(true));
  test("LP4 undeclared counter", () => expect(fires(method({ type: "LOOP_EXECUTION_ON_NUMBER", value: "3", counter: "#{nope}" }, { counterVar: false }), "LP4")).toBe(true));
  test("LP5 unknown field is a warning", () => {
    const m = method({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{items}", loopVariable: "x" });
    expect(warns(m, "LP5").length).toBe(1);
    expect(errs(m, "LP5")).toEqual([]);
  });
  test("LP6 unresolved loop value is a warning", () => {
    const m = method({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{doesNotExist}" }, { valueInput: false });
    expect(warns(m, "LP6").length).toBe(1);
    expect(errs(m, "LP6")).toEqual([]);
  });
  test("no loop → no LP finding", () => expect(lp({ ...SIMPLE_ECHO })).toEqual([]));
});

describe("SP1 (test_validate_sp1.py)", () => {
  const method = (value: string): M => ({
    name: "SpelCase", inputs: [{ key: "a", name: "a", type: "STRING" }], outputs: [], variables: [],
    steps: [{ serviceName: "Helpers.String", methodName: "echo", properties: { type: "EXISTING_SERVICE" }, inputs: [{ key: "input", value, type: "STRING" }], outputs: [{ key: "response", name: "outn", fieldCode: "outc" }] }],
  });
  const nestedMethod = (value: string): M => ({
    ...method(""),
    steps: [{ serviceName: "Helpers.JSON", methodName: "fetchKeyValue", properties: { type: "EXISTING_SERVICE" }, inputs: [{ key: "body", type: "OBJECT", properties: [{ key: "json", value }] }], outputs: [{ key: "response", name: "outn", fieldCode: "outc" }] }],
  });
  const KNOWN_GOOD = [
    "#{a}", "#{a.email}", "#{a + ' ' + a}", "#{a + ', ' + a + '!'}", "#{a > 18 ? 'adult' : 'minor'}", "#{a == 'ACTIVE' ? 'on' : 'off'}",
    "#{a.?[amount > 10].?[status == 'OK']}", "#{a?.address?.city}", "plain literal, no spel at all",
    "#{T(java.lang.Integer).parseInt(a) + T(java.lang.Integer).parseInt(a)}",
    "#{T(java.lang.Integer).parseInt(a) + T(java.lang.Integer).parseInt(a) + T(java.lang.Integer).parseInt(a)}",
  ];
  for (const expr of KNOWN_GOOD) test(`known-good clean: ${expr.slice(0, 34)}`, () => expect(warns(method(expr), "SP1")).toEqual([]));
  const NESTED = "#{a >= 90 ? 'A' : a >= 80 ? 'B' : a >= 70 ? 'C' : 'F'}";
  test("nested ternary warns", () => expect(warns(method(NESTED), "SP1").length).toBe(1));
  test("chained-ops monolith warns", () => expect(warns(method("#{T(java.lang.Integer).parseInt(a) + a - a * a / a + a - a > 0 ? 'y' : 'n'}"), "SP1").length).toBe(1));
  test("nested-body nested ternary warns", () => expect(warns(nestedMethod(NESTED), "SP1").length).toBe(1));
  test("never an error", () => expect(errs(method(NESTED), "SP1")).toEqual([]));
});

describe("VB1 (test_validate_vb1.py)", () => {
  const method = (output: unknown): M => ({
    name: "Vb1Probe", inputs: [{ key: "msg", name: "msg", type: "STRING" }], outputs: [], variables: [{ key: "stash", name: "stash", type: "STRING" }],
    steps: [{ serviceName: "Helpers.String", methodName: "echo", properties: { type: "EXISTING_SERVICE" }, inputs: [{ key: "input", value: "#{msg}", type: "STRING" }], outputs: [output] }],
  });
  const ir = { type: "method_input", reference: "stash" };
  test("name + fieldCode: silent", () => expect(fires(method({ key: "response", fieldCode: "stashOut", name: "stashOut", inputReference: ir }), "VB1")).toBe(false));
  test("nameless: fires", () => expect(fires(method({ key: "response", fieldCode: "stashOut", name: "", inputReference: ir }), "VB1")).toBe(true));
  test("no fieldCode: fires", () => expect(fires(method({ key: "response", fieldCode: "", name: "stashOut", inputReference: ir }), "VB1")).toBe(true));
  test("name == fieldCode == variable: silent", () => expect(fires(method({ key: "response", fieldCode: "stash", name: "stash", inputReference: ir }), "VB1")).toBe(false));
  test("non-variable output: out of VB1 scope", () => expect(fires(method({ key: "response", fieldCode: "resp", name: "" }), "VB1")).toBe(false));
});

describe("NC1 / DUP1 (test_validate_nc1_dup1.py)", () => {
  const method = (outputs: unknown[]): M => ({
    name: "F3Probe", inputs: [{ key: "msg", name: "msg", type: "STRING" }], outputs: [], variables: [],
    steps: [{ serviceName: "Helpers.String", methodName: "echo", properties: { type: "EXISTING_SERVICE" }, inputs: [{ key: "input", value: "#{msg}", type: "STRING" }], outputs }],
  });
  const out = (name: string, fc: string) => ({ key: "response", name, fieldCode: fc });
  const t: Array<[string, unknown[], string, boolean]> = [
    ["name space", [out("bad name", "okCode")], "NC1", true],
    ["name punct", [out("bad!name", "okCode")], "NC1", true],
    ["fieldCode hyphen", [out("okName", "ok-code")], "NC1", true],
    ["fieldCode dot", [out("okName", "ok.code")], "NC1", true],
    ["fieldCode tilde", [out("okName", "okcode~")], "NC1", true],
    ["good underscore", [out("okName", "ok_code")], "NC1", false],
    ["empty name is not NC1", [out("", "")], "NC1", false],
    ["dup name", [out("dup", "codeA"), out("dup", "codeB")], "DUP1", true],
    ["dup fieldCode", [out("nameA", "dupCode"), out("nameB", "dupCode")], "DUP1", true],
    ["distinct", [out("nameA", "codeA"), out("nameB", "codeB")], "DUP1", false],
  ];
  for (const [label, outputs, code, want] of t) test(`${code} ${want ? "fires" : "silent"}: ${label}`, () => expect(firesAny(method(outputs), code)).toBe(want));
  test("pipeline: same variable, distinct fieldCodes → no DUP1", () => {
    const m: M = {
      ...method([]),
      variables: [{ key: "currentName", name: "currentName", type: "TEXT" }],
      steps: [
        { serviceName: "Helpers.JSON", methodName: "fetchKeyValue", properties: { type: "EXISTING_SERVICE" }, inputs: [], outputs: [{ key: "response", fieldCode: "extractedName", name: "extractedName", inputReference: { type: "method_input", reference: "currentName" } }] },
        { serviceName: "Helpers.Legacy", methodName: "echo", properties: { type: "EXISTING_SERVICE" }, inputs: [], outputs: [{ key: "response", fieldCode: "loweredName", name: "loweredName", inputReference: { type: "method_input", reference: "currentName" } }] },
      ],
    };
    expect(firesAny(m, "DUP1")).toBe(false);
  });
});

describe("OK1 / ON1 (test_validate_ok1_on1.py)", () => {
  const method = (outputs: unknown[]): M => ({
    name: "OKProbe", inputs: [{ key: "msg", name: "msg", type: "STRING" }], outputs, variables: [],
    steps: [{ serviceName: "Helpers.String", methodName: "echo", properties: { type: "EXISTING_SERVICE" }, inputs: [{ key: "input", value: "#{msg}", type: "STRING" }], outputs: [{ key: "response", name: "echoed", fieldCode: "echoed" }] }],
  });
  test("fieldCode instead of key", () => expect(fires(method([{ name: "echoed", fieldCode: "echoed" }]), "OK1")).toBe(true));
  test("key missing", () => expect(fires(method([{ name: "echoed" }]), "OK1")).toBe(true));
  test("key empty", () => expect(fires(method([{ key: "", name: "echoed" }]), "OK1")).toBe(true));
  test("key whitespace", () => expect(fires(method([{ key: "   ", name: "echoed" }]), "OK1")).toBe(true));
  for (const bad of ["has space", "with-hyphen", "with.dot", "with~tilde", "with/slash"]) test(`OK1 fires on ${bad}`, () => expect(fires(method([{ key: bad, name: "echoed" }]), "OK1")).toBe(true));
  for (const good of ["echoed", "sum_result", "output2", "A", "_leading", "camelCase99"]) test(`OK1 silent on ${good}`, () => expect(fires(method([{ key: good, name: "echoed" }]), "OK1")).toBe(false));
  for (const bad of ["Echoed message", "with-hyphen", "with.dot", "with~tilde", "trailing "]) test(`ON1 fires on ${JSON.stringify(bad)}`, () => expect(fires(method([{ key: "echoed", name: bad }]), "ON1")).toBe(true));
  for (const good of ["echoed", "Greeting", "Result", "sum_result", "out2"]) test(`ON1 silent on ${good}`, () => expect(fires(method([{ key: "echoed", name: good }]), "ON1")).toBe(false));
  test("ON1 silent when name absent or empty", () => {
    expect(fires(method([{ key: "echoed" }]), "ON1")).toBe(false);
    expect(fires(method([{ key: "echoed", name: "" }]), "ON1")).toBe(false);
  });
  test("known-good method is clean", () => expect(run(method([{ key: "echoed", name: "echoed", type: "STRING", description: "The message echoed back" }])).errors).toEqual([]));
});

describe("IK1 / M1 / VK1 (test_validate_g4g5g6.py)", () => {
  const method = (over: M = {}): M => ({
    name: "OkName", inputs: [{ key: "okIn", name: "okIn", type: "STRING" }], outputs: [], variables: [],
    steps: [{ serviceName: "Helpers.String", methodName: "echo", properties: { type: "EXISTING_SERVICE" }, inputs: [{ key: "input", value: "x", type: "STRING" }], outputs: [{ key: "response", name: "okn", fieldCode: "okc" }] }],
    ...over,
  });
  const inp = (key: string) => ({ inputs: [{ key, name: key, type: "STRING" }] });
  const vr = (key: string) => ({ variables: [{ key, name: key, type: "STRING" }] });
  const t: Array<[string, M, string, boolean]> = [
    ["input key space", inp("bad key"), "IK1", true],
    ["input key hyphen", inp("bad-key"), "IK1", true],
    ["input key dot", inp("bad.key"), "IK1", true],
    ["input key ok_key", inp("ok_key"), "IK1", false],
    ["method hyphen", { name: "F3b-g5" }, "M1", false],
    ["method tilde", { name: "F3b~g5" }, "M1", false],
    ["method leading dot", { name: ".foo" }, "M1", true],
    ["method trailing dot", { name: "foo." }, "M1", true],
    ["method space", { name: "bad name" }, "M1", true],
    ["method internal dot+underscore", { name: "Helpers_x.echo2" }, "M1", false],
    ["variable key dot (rejected live)", vr("ok.var"), "VK1", true],
    ["variable key space", vr("bad var"), "VK1", true],
    ["variable key hyphen", vr("bad-var"), "VK1", true],
    ["variable key ok_var", vr("ok_var"), "VK1", false],
  ];
  for (const [label, over, code, want] of t) test(`${code} ${want ? "fires" : "silent"}: ${label}`, () => expect(fires(method(over), code)).toBe(want));
});
