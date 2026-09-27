// lib/ids.ts — one canonical method uuid for every AD command (AD-30, F11).
import { describe, expect, test } from "bun:test";
import { normalizeUuid, resolveMethodRef } from "../../lib/ids";

const U = "4bf56e008eabe4010508af439a15ecfb";

describe("resolveMethodRef", () => {
  const accepted: Array<[string, string]> = [
    ["plain", U],
    ["padded like the wire", `${U}    `],
    ["leading space + tab", ` \t${U}`],
    ["upper case", U.toUpperCase()],
    ["dashed", "4bf56e00-8eab-e401-0508-af439a15ecfb"],
    ["dashed upper", "4BF56E00-8EAB-E401-0508-AF439A15ECFB"],
    ["AD URL", `https://sems-dev.qa.expertly.cloud/automation-designer/Test-Parth/${U}`],
    ["AD URL, trailing slash", `https://sems-dev.qa.expertly.cloud/automation-designer/Test-Parth/${U}/`],
    ["AD URL with query + hash", `https://sems-dev.qa.expertly.cloud/automation-designer/Test%20Cat/${U}?tab=1#step-3`],
    ["AD URL without scheme", `sems-dev.qa.expertly.cloud/automation-designer/Test-Parth/${U}`],
    ["padded URL", `  https://x.test/automation-designer/Cat/${U.toUpperCase()}  `],
  ];
  for (const [name, input] of accepted) {
    test(`accepts ${name}`, () => expect(resolveMethodRef(input)).toBe(U));
  }

  const rejected: Array<[string, string]> = [
    ["empty", ""],
    ["31 hex", U.slice(1)],
    ["non-hex", "zzf56e008eabe4010508af439a15ecfb"],
    ["numeric chain id", "20037"],
    ["URL without uuid", "https://sems-dev.qa.expertly.cloud/automation-designer/Test-Parth"],
    ["uuid with inner space", "4bf56e008eab e4010508af439a15ecfb"],
  ];
  for (const [name, input] of rejected) {
    test(`rejects ${name} with INVALID_UUID`, () => {
      expect(() => resolveMethodRef(input)).toThrow(expect.objectContaining({ code: "INVALID_UUID" }));
    });
  }
});

describe("normalizeUuid", () => {
  test("trims padding, keeps case and dashes; empty → null", () => {
    expect(normalizeUuid("4037ada88a1a3ac30a1c9e63b6b0eed6    ")).toBe("4037ada88a1a3ac30a1c9e63b6b0eed6");
    expect(normalizeUuid("cbde649a-7385-4c1b-a57a-41f7f023590b")).toBe("cbde649a-7385-4c1b-a57a-41f7f023590b");
    expect(normalizeUuid("   ")).toBeNull();
    expect(normalizeUuid(null)).toBeNull();
  });
});
