import { describe, expect, test } from "bun:test";
import { encodeBase64, decodeBase64Strict } from "../../lib/base64";

describe("base64 helper", () => {
  test("round-trips ascii", () => {
    const original = "Hello, World!";
    expect(decodeBase64Strict(encodeBase64(original))).toBe(original);
  });

  test("round-trips utf-8 with emoji", () => {
    const original = "café — 🚀";
    expect(decodeBase64Strict(encodeBase64(original))).toBe(original);
  });

  test("round-trips JavaScript source", () => {
    const src = "var x = 1;\nvar y = 2;\nconsole.log(JSON.stringify({sum: x + y}));";
    expect(decodeBase64Strict(encodeBase64(src))).toBe(src);
  });

  test("decodeBase64Strict accepts canonical base64 only", () => {
    expect(decodeBase64Strict(encodeBase64("console.log('hi');"))).toBe("console.log('hi');");
    expect(decodeBase64Strict(encodeBase64("café — 🚀"))).toBe("café — 🚀");
    // plain JS is not base64
    expect(decodeBase64Strict('const g = "#{greeting}";\nconsole.log(g);')).toBeNull();
    expect(decodeBase64Strict("console.log(1)")).toBeNull();
    // wrong length / bad padding / non-canonical trailing bits / whitespace
    expect(decodeBase64Strict("abc")).toBeNull();
    expect(decodeBase64Strict("ab=c")).toBeNull();
    expect(decodeBase64Strict("QQ==\n")).toBeNull();
    expect(decodeBase64Strict("QR==")).toBeNull();
    expect(decodeBase64Strict("")).toBeNull();
    // decodes to invalid UTF-8
    expect(decodeBase64Strict("//79")).toBeNull();
  });
});
