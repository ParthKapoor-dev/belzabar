// Execution failure bodies (`ad run` /chain/execute, a non-2xx `ad test`) reduced to the
// method's own message, failing step and status (B10, B17, B18). The bodies have the
// shapes the server answered live (2026-11-18) for a custom-code throw and an exit-on-failure 403.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { decodeJsonText, executionError, executionFailure } from "../../lib/exec-error";
import { ErrorParser } from "../../lib/error-parser";

const STACK = "<anonymous>:8: Error: custom boom: boom\n    };function executeJs(){ throw new Error('custom boom'); }\n    at executeJs (<anonymous>:8:59)";
/** A custom-code throw: the body's message is JSON text of {status, status_message, error}. */
const codeThrow = (error = STACK) => ({
  executed: false,
  message: JSON.stringify({ status: 500, status_message: "Error!", error }),
  failed: true,
  statusCode: 500,
  failingSteps: [9],
  failingStepsStatuses: [{ executed: false, failed: true, statusCode: 500, stepIndex: 9, message: JSON.stringify({ status: 500, status_message: "Error!", error }) }],
});
/** An exit-on-failure refusal with code 403. */
const refusal = {
  executed: false,
  message: "denied by design",
  failed: true,
  statusCode: 403,
  failingSteps: [1],
  failingStepsStatuses: [{ executed: false, message: "denied by design", failed: true, statusCode: 403, stepIndex: 1, errorMessage: "denied by design" }],
  errorMessage: "denied by design",
};

describe("decodeJsonText", () => {
  test("JSON text inside JSON text inside a field becomes objects", () => {
    const twice = JSON.stringify(JSON.stringify({ message: JSON.stringify({ result: { message: "INVALID_INPUTS: x" } }) }));
    expect(decodeJsonText(twice)).toEqual({ message: { result: { message: "INVALID_INPUTS: x" } } });
    expect(decodeJsonText("plain text")).toBe("plain text");
    expect(decodeJsonText("{not json")).toBe("{not json");
  });
});

describe("executionFailure", () => {
  test("a custom-code throw: step 9, status 500, the first line of the error", () => {
    expect(executionFailure(decodeJsonText(JSON.stringify(codeThrow())))).toEqual({
      status: 500,
      step: 9,
      message: "<anonymous>:8: Error: custom boom: boom",
    });
  });
  test("a refusal: the step's own status and message", () => {
    expect(executionFailure(refusal, 403)).toEqual({ status: 403, step: 1, message: "denied by design" });
  });
  test("a double-encoded body with no step", () => {
    const body = decodeJsonText(JSON.stringify(JSON.stringify({ message: "INVALID_INPUTS: settingName must be set" })));
    expect(executionFailure(body, 400)).toEqual({ status: 400, step: null, message: "INVALID_INPUTS: settingName must be set" });
  });
});

describe("executionError", () => {
  test("the method's message and failing step are in error.message; details.body is decoded (B10)", async () => {
    const res = new Response(JSON.stringify(codeThrow()), { status: 500 });
    const err = await executionError(res, { code: "EXECUTION_FAILED", label: "Execution failed", path: "/x", tag: "t" });
    expect(err.code).toBe("EXECUTION_FAILED");
    expect(err.message).toBe("Execution failed (500) at step 9: <anonymous>:8: Error: custom boom: boom");
    const d = err.details as any;
    expect(d).toMatchObject({ path: "/x", status: 500, step: 9, methodMessage: "<anonymous>:8: Error: custom boom: boom" });
    expect(d.body.message.error).toContain("custom boom"); // an object, not JSON text
    expect(d.bodyFile).toBeUndefined();
  });

  test("a long body is written whole to a file named in the error (B18)", async () => {
    const big = `BIGSTART ${"x".repeat(60_000)} BIGTAIL`;
    const res = new Response(JSON.stringify(codeThrow(big)), { status: 500 });
    const err = await executionError(res, { code: "EXECUTION_FAILED", label: "Execution failed", tag: "t" });
    const d = err.details as any;
    expect(typeof d.body).toBe("string"); // the envelope keeps a summary
    expect(d.bodyFile).toBeString();
    expect(err.message).toContain(d.bodyFile);
    expect(err.message).toContain("at step 9: BIGSTART");
    expect(existsSync(d.bodyFile)).toBe(true);
    expect(readFileSync(d.bodyFile, "utf8")).toContain("BIGTAIL"); // the part that used to be cut
  });

  test("the saved body is redacted", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlc2ln";
    const res = new Response(JSON.stringify({ ...codeThrow(`${"y".repeat(20_000)} Bearer ${jwt}`) }), { status: 500 });
    const err = await executionError(res, { code: "E", label: "Execution failed", tag: "t" });
    expect(readFileSync((err.details as any).bodyFile, "utf8")).not.toContain(jwt);
  });
});

describe("ErrorParser (step status)", () => {
  test("a custom-code error and a plain refusal give the method's own first line", () => {
    expect(ErrorParser.parse({ message: JSON.stringify({ status: 500, error: STACK }) }).summary).toBe("<anonymous>:8: Error: custom boom: boom");
    expect(ErrorParser.parse({ message: "denied by design" }).summary).toBe("denied by design");
  });
});
