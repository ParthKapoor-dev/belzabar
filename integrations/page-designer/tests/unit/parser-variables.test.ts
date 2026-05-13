import { describe, test, expect } from "bun:test";
import { parseVariables } from "../../lib/parser/variables";
import type { RawConfiguration } from "../../lib/types/wire";

describe("parseVariables", () => {
  test("new format: variables.userDefined → PageVariable[]", () => {
    const config: RawConfiguration = {
      variables: {
        generated: [],
        userDefined: [
          { name: "a", type: "String", initialValue: "hi" },
          { name: "b", type: "Any", initialValue: null },
        ],
        derived: [],
      },
    };
    const { userDefined, derived } = parseVariables(config);
    expect(userDefined.map((v) => v.name)).toEqual(["a", "b"]);
    expect(userDefined[0]!.type).toBe("String");
    expect(userDefined[0]!.initialValue).toBe("hi");
    expect(derived).toEqual([]);
  });

  test("legacy format: context.properties → PageVariable[]", () => {
    const config: RawConfiguration = {
      context: {
        properties: [
          ["legacyA", "one"],
          ["legacyB", 42],
        ],
      },
    };
    const { userDefined } = parseVariables(config);
    expect(userDefined.map((v) => v.name)).toEqual(["legacyA", "legacyB"]);
    expect(userDefined[0]!.type).toBeNull();
    expect(userDefined[1]!.initialValue).toBe(42);
  });

  test("new format preferred over legacy when both present", () => {
    const config: RawConfiguration = {
      variables: { userDefined: [{ name: "newFmt" }] },
      context: { properties: [["legacy", 1]] },
    };
    const { userDefined } = parseVariables(config);
    expect(userDefined.map((v) => v.name)).toEqual(["newFmt"]);
  });

  test("derived variables populated from variables.derived (or context.derived)", () => {
    const config: RawConfiguration = {
      variables: {
        userDefined: [{ name: "raw" }],
        derived: [
          {
            name: "computed",
            from: ["raw"],
            spec: "(function(p){return p.raw;})",
            filterFn: null,
            sideEffect: false,
          } as unknown as RawConfiguration["variables"]["derived"][number],
        ],
      },
    };
    const { derived } = parseVariables(config);
    expect(derived).toHaveLength(1);
    expect(derived[0]!.name).toBe("computed");
    expect(derived[0]!.from).toEqual(["raw"]);
    expect(derived[0]!.sideEffect).toBe(false);
  });

  test("duplicate variable names warn and skip", () => {
    const config: RawConfiguration = {
      variables: {
        userDefined: [
          { name: "dup", type: "String" },
          { name: "dup", type: "Any" },
        ],
      },
    };
    const { userDefined, warnings } = parseVariables(config);
    expect(userDefined).toHaveLength(1);
    expect(warnings[0]).toContain("duplicate variable");
  });
});
