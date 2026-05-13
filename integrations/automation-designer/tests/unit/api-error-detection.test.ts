import { describe, expect, test } from "bun:test";
import { detectJavaException } from "../../lib/error-parser";

describe("detectJavaException", () => {
  test("returns null for a normal test response", () => {
    const body = {
      executionStatus: { failed: false },
      services: [],
      outputs: [],
    };
    expect(detectJavaException(body)).toBeNull();
  });

  test("detects a Java exception shape", () => {
    const body = {
      message: "javax.servlet.ServletException",
      stackTrace: ["at foo.bar.Baz(Baz.java:42)"],
      cause: { message: "Invalid Automation API Id - 12345" },
    };
    const detected = detectJavaException(body);
    expect(detected).not.toBeNull();
    expect(detected?.message).toBe("javax.servlet.ServletException");
    expect(detected?.causeMessage).toBe("Invalid Automation API Id - 12345");
    expect(detected?.badAutomationApiId).toBe("12345");
  });

  test("falls back to localizedMessage when message is missing", () => {
    const body = {
      message: "wrapper",
      stackTrace: [],
      cause: { localizedMessage: "Invalid Automation API Id - 99" },
    };
    const detected = detectJavaException(body);
    expect(detected?.causeMessage).toBe("Invalid Automation API Id - 99");
    expect(detected?.badAutomationApiId).toBe("99");
  });

  test("null for non-object input", () => {
    expect(detectJavaException(null)).toBeNull();
    expect(detectJavaException("text")).toBeNull();
    expect(detectJavaException(42)).toBeNull();
  });

  test("null when stackTrace is not an array", () => {
    const body = { message: "x", stackTrace: "not an array" };
    expect(detectJavaException(body)).toBeNull();
  });
});
