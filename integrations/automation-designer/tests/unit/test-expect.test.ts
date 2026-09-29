// 7.7: `ad test --expect` expressions and the test-case assertion encoding
// (advance-mode SpEL `#{out} op literal`, api-endpoints.md §8.5).
import { describe, expect, test } from "bun:test";
import {
  assertionExpression,
  assertionFromExpectation,
  assertionFromWire,
  assertionToWire,
  evaluateExpectation,
  expectationFromAssertion,
  parseExpectation,
} from "../../lib/test-cases/expect";

const run = (outputs: Record<string, unknown>, e: string) => evaluateExpectation(outputs, parseExpectation(e));

describe("parseExpectation", () => {
  test.each([
    ["out=Hello World", "eq", "Hello World"],
    ["out!=x", "neq", "x"],
    ["out~=Wor", "contains", "Wor"],
    ["count>=3", "ge", 3],
    ["count<=3", "le", 3],
    ["count>3", "gt", 3],
    ["count<3", "lt", 3],
    ["flag=true", "eq", true],
    ["n=null", "eq", null],
    ["obj={\"a\":1}", "eq", { a: 1 }],
    ["s='42'", "eq", "42"],
    ["s=", "eq", ""],
  ])("%s", (src, op, expected) => {
    const e = parseExpectation(src);
    expect(e.op).toBe(op as any);
    expect(e.expected).toEqual(expected);
  });

  test("path into a JSON output", () => {
    expect(parseExpectation("res.rows[0].id=7").path).toEqual(["rows", 0, "id"]);
  });

  test("bad input fails with INVALID_EXPECTATION", () => {
    for (const bad of ["=x", "out", "1out=x", "n>abc"]) {
      expect(() => parseExpectation(bad)).toThrow(expect.objectContaining({ code: "INVALID_EXPECTATION" }));
    }
  });
});

describe("evaluateExpectation", () => {
  const out = { greetingOut: "Hello World", count: "42", json: '{"rows":[{"id":7}],"ok":true}', arr: "[1,2,3]", nul: null };

  test("text outputs compare to typed values", () => {
    expect(run(out, "greetingOut=Hello World").pass).toBe(true);
    expect(run(out, "count=42").pass).toBe(true); // "42" (wire text) == 42
    expect(run(out, "count='42'").pass).toBe(true);
    expect(run(out, "count>41").pass).toBe(true);
    expect(run(out, "count<=41").pass).toBe(false);
    expect(run(out, "greetingOut!=Hello").pass).toBe(true);
    expect(run(out, "greetingOut~=World").pass).toBe(true);
    expect(run(out, "nul=null").pass).toBe(true);
  });

  test("JSON outputs: whole value, path, contains", () => {
    expect(run(out, 'json={"ok":true,"rows":[{"id":7}]}').pass).toBe(true);
    expect(run(out, "json.rows[0].id=7").pass).toBe(true);
    expect(run(out, "json.ok=true").pass).toBe(true);
    expect(run(out, "arr~=2").pass).toBe(true);
    expect(run(out, "arr~=9").pass).toBe(false);
  });

  test("failures carry a reason", () => {
    const r = run(out, "greetingOut=Hello Mars");
    expect(r).toMatchObject({ pass: false, actual: "Hello World" });
    expect(r.reason).toContain("Hello Mars");
    expect(run(out, "missing=1").reason).toContain("not in the result");
    expect(run(out, "json.rows[5].id=1").reason).toContain("not found");
    expect(run(out, "greetingOut>1").reason).toBe("actual value is not a number");
  });
});

describe("assertions ↔ SpEL (UI encoding)", () => {
  test("scalar values; strings quoted with '' escapes", () => {
    const a = assertionFromExpectation(parseExpectation("greetingOut=O'Brien"));
    expect(assertionExpression(a)).toBe("#{greetingOut} eq 'O''Brien'");
    expect(assertionToWire(a)).toEqual({ mode: "advance", conditionExpression: "#{greetingOut} eq 'O''Brien'", conditions: null });
    expect(assertionExpression(assertionFromExpectation(parseExpectation("n>5")))).toBe("#{n} gt 5");
    expect(assertionExpression(assertionFromExpectation(parseExpectation("n='5'")))).toBe("#{n} eq '5'");
    expect(assertionExpression(assertionFromExpectation(parseExpectation("b!=false")))).toBe("#{b} neq false");
  });

  test("UI-unsupported shapes are refused", () => {
    for (const bad of ["a.b=1", "n>=1", "o={\"a\":1}"]) {
      expect(() => assertionFromExpectation(parseExpectation(bad))).toThrow(expect.objectContaining({ code: "INVALID_ASSERTION" }));
    }
  });

  test("read back: structured when parseable, raw otherwise", () => {
    expect(assertionFromWire({ mode: "advance", conditionExpression: "#{greetingOut} contains 'O''Brien'" })).toEqual({
      output: "greetingOut",
      op: "contains",
      expected: "O'Brien",
    });
    expect(assertionFromWire({ mode: "advance", conditionExpression: "#{n} gt -1.5" })).toEqual({ output: "n", op: "gt", expected: -1.5 });
    expect(assertionFromWire({ mode: "advance", conditionExpression: "#{a} eq #{b}" })).toEqual({ expression: "#{a} eq #{b}" });
    expect(assertionFromWire({ mode: "basic", conditionExpression: "#{a} eq 'x'", conditions: '[{"x":1}]' })).toEqual({
      expression: "#{a} eq 'x'",
      mode: "basic",
      conditions: [{ x: 1 }],
    });
  });

  test("a structured assertion evaluates like --expect", () => {
    const e = expectationFromAssertion({ output: "greetingOut", op: "eq", expected: "Hello World" });
    expect(evaluateExpectation({ greetingOut: "Hello World" }, e).pass).toBe(true);
    const q = expectationFromAssertion({ output: "n", op: "eq", expected: "42" });
    expect(evaluateExpectation({ n: 42 }, q).pass).toBe(true);
  });
});
