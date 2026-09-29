import { describe, expect, test } from "bun:test";
import { defineArgs } from "@belzabar/core";
import { AD_V2_FLAG, apiVersionOf } from "../../lib/args/common";

describe("AD --v2 flag", () => {
  const def = defineArgs({ positionals: [{ name: "uuid" }], flags: { ...AD_V2_FLAG } });

  test("V1 by default", () => {
    expect(apiVersionOf(def.parse(["abc"]).flags)).toBe("v1");
  });

  test("--v2 selects V2", () => {
    const { flags, positionals } = def.parse(["abc", "--v2"]);
    expect(positionals.uuid).toBe("abc");
    expect(apiVersionOf(flags)).toBe("v2");
  });
});
