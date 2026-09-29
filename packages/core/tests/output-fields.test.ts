import { describe, expect, test } from "bun:test";
import { CliError, isEmptyValue, parseFieldList, pickFields, projectRow } from "../src";

describe("--fields helpers", () => {
  test("isEmptyValue keeps false and 0", () => {
    expect([null, undefined, "", [], {}].every(isEmptyValue)).toBe(true);
    expect(isEmptyValue(false) || isEmptyValue(0)).toBe(false);
  });

  test("parseFieldList: absent → default, all, pick, unknown → INVALID_VALUE", () => {
    expect(parseFieldList(undefined, ["a"])).toEqual({ mode: "default" });
    expect(parseFieldList("a,all", ["a"])).toEqual({ mode: "all" });
    expect(parseFieldList(" a ,b", ["a", "b"])).toEqual({ mode: "pick", fields: ["a", "b"] });
    try {
      parseFieldList("x", ["a"]);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe("INVALID_VALUE");
      expect((e as CliError).details).toEqual({ flag: "--fields", unknown: ["x"], known: ["a"] });
    }
  });

  test("pickFields / projectRow drop empties; all returns the row itself", () => {
    const full = { a: 1, b: "", c: [1] };
    expect(pickFields(full, ["c", "a", "b", "z"])).toEqual({ c: [1], a: 1 });
    expect(projectRow(full, { mode: "default" }, ["a", "b"])).toEqual({ a: 1 });
    expect(projectRow(full, { mode: "all" }, ["a"])).toBe(full);
  });
});
