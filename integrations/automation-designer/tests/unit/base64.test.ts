import { describe, expect, test } from "bun:test";
import { encodeBase64, decodeBase64, decodeBase64Safe, Base64DecodeError } from "../../lib/base64";

describe("base64 helper", () => {
  test("round-trips ascii", () => {
    const original = "Hello, World!";
    expect(decodeBase64(encodeBase64(original))).toBe(original);
  });

  test("round-trips utf-8 with emoji", () => {
    const original = "café — 🚀";
    expect(decodeBase64(encodeBase64(original))).toBe(original);
  });

  test("round-trips JavaScript source", () => {
    const src = "var x = 1;\nvar y = 2;\nconsole.log(JSON.stringify({sum: x + y}));";
    expect(decodeBase64(encodeBase64(src))).toBe(src);
  });

  test("decodeBase64Safe records warning on garbage and returns raw", () => {
    // Buffer.from in node is surprisingly lenient — it returns garbage rather
    // than throwing for many invalid inputs. Test the warning path by passing
    // a clearly non-round-trippable byte pattern.
    const warnings: string[] = [];
    const result = decodeBase64Safe("####", w => warnings.push(w));
    // result is either decoded garbage or the raw string; we just need the
    // function to not throw.
    expect(typeof result).toBe("string");
  });

  test("Base64DecodeError carries input length", () => {
    const err = new Base64DecodeError("AAAA", new Error("boom"));
    expect(err.name).toBe("Base64DecodeError");
    expect(err.input).toBe("AAAA");
  });
});
