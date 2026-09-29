import { describe, expect, test } from "bun:test";
import { asObj, dedupeBy, isObj, levenshtein, normalizeSearchText, num, numLike, scoreText, str, strOrNull, suggest } from "../src";

describe("guards", () => {
  test("isObj / asObj accept plain objects only", () => {
    expect(isObj({})).toBe(true);
    expect(isObj([])).toBe(false);
    expect(isObj(null)).toBe(false);
    expect(asObj("x")).toBeNull();
    expect(asObj({ a: 1 })).toEqual({ a: 1 });
  });

  test("str / strOrNull trim and reject blanks", () => {
    expect(str("  a ")).toBe("a");
    expect(str("   ")).toBeUndefined();
    expect(str(1)).toBeUndefined();
    expect(strOrNull(" b")).toBe("b");
    expect(strOrNull("")).toBeNull();
  });

  test("num is strict, numLike parses numeric strings", () => {
    expect(num(3)).toBe(3);
    expect(num("3")).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(numLike("42")).toBe(42);
    expect(numLike(" ")).toBeNull();
    expect(numLike("x")).toBeNull();
  });
});

describe("search", () => {
  test("scoreText tiers: exact > prefix > word start > substring > fuzzy", () => {
    const q = normalizeSearchText("  Order ");
    const exact = scoreText(q, "order", 1);
    const prefix = scoreText(q, "orders list", 1);
    const word = scoreText(q, "get_order", 1);
    const sub = scoreText(q, "reorders", 1);
    const fuzzy = scoreText(q, "ordr", 1);
    expect([exact, prefix, word, sub]).toEqual([1000, 900, 850, 760]);
    expect(fuzzy).toBeGreaterThan(0);
    expect(fuzzy).toBeLessThan(sub);
    expect(scoreText(q, "zzz", 1)).toBe(0);
    expect(scoreText(q, "order", 0.5)).toBe(500);
  });

  test("levenshtein", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });

  test("dedupeBy keeps the last item per key", () => {
    expect(dedupeBy([{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "a", v: 3 }], (x) => x.k)).toEqual([
      { k: "a", v: 3 },
      { k: "b", v: 2 },
    ]);
  });

  test("arg suggestions still use the shared edit distance", () => {
    expect(suggest("--verbos", ["--verbose", "--env"])).toBe("--verbose");
  });
});
