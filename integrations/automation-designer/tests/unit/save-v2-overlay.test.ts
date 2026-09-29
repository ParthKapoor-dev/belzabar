// `ad save` overlay → V2 body, on real V2 wire bodies: no field is dropped,
// SQL keeps its encoding, unedited steps are not rewritten, plain custom code
// stays plain.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import { CliError } from "@belzabar/core";
import { planV2Overlay } from "../../lib/serialize/v2";
import { diffPaths, getAtPath } from "../../lib/serialize/diff";
import { decodeBase64Strict, encodeBase64 } from "../../lib/base64";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import { errorCode as code, jsonFixtures } from "@belzabar/core/testing";

const DIR = `${import.meta.dir}/../fixtures/real-v2`;
const files = readdirSync(DIR).filter((f) => f.endsWith(".v2.json")).sort();
const load = (uuid: string) => jsonFixtures(DIR, ".v2.json")<V2MethodResponse>(uuid);
const fresh = (uuid: string): V2MethodResponse => structuredClone(load(uuid));

const SQL_NONE = "41bb1b438875bd8b994196db1f12b7c2"; // 1: SQL read (NONE), 2: CC plain
const SQL_B64 = "4ada8d56841853491129898f5069679e"; // 1: SQL read BASE_64
const ECHO = "486041dfd02d9fd45a27b608ad2dce0c"; // 2: echo, 3: SQL BASE_64
const CC_B64 = "438185931da72f5b89aaac3c6248a18e"; // 12: CC base64 (PUBLISHED body, shape only)
const LEAN = "40b7959fb1dd8b4cf2ee9f5e54630ea8"; // 3: CC plain step without id/automationAPIId

describe("round-trip invariant over the 36 real V2 bodies", () => {
  test("fixture set present", () => expect(files.length).toBe(36));

  for (const f of files) {
    const uuid = f.slice(0, 32);
    test(`${uuid.slice(0, 12)}: only the targeted leaves change; a no-op overlay is refused`, () => {
      const live = load(uuid);
      const before = JSON.stringify(live);
      // no-op: value identical to the live one
      expect(code(() => planV2Overlay(live, { name: live.name }))).toBe("AD_OVERLAY_NOT_APPLIED");
      // one change per step (description) + name: diff is exactly those paths
      const steps = live.steps ?? [];
      const overlay = {
        name: `${live.name}_x`,
        parsedSteps: steps.map((_, i) => ({ orderIndex: i + 1, description: `d${i + 1}` })),
      };
      const plan = planV2Overlay(live, overlay);
      const changed = diffPaths(live, plan.body).sort();
      const expected = ["name", ...steps.map((s, i) => (s.description === `d${i + 1}` ? null : `steps[${i}].description`))]
        .filter((p): p is string => p !== null)
        .sort();
      expect(changed).toEqual(expected);
      expect(JSON.stringify(live)).toBe(before); // live never mutated
      expect(plan.body.metadata).toEqual(live.metadata);
    });
  }
});

describe("overlay → payload, per field kind", () => {
  const cases: Array<{
    name: string;
    uuid: string;
    overlay: Record<string, unknown>;
    path: string;
    value: (live: V2MethodResponse) => unknown;
  }> = [
    { name: "name", uuid: LEAN, overlay: { name: "renamed.m-1" }, path: "name", value: () => "renamed.m-1" },
    { name: "summary (absent key is added)", uuid: SQL_NONE, overlay: { summary: "S" }, path: "summary", value: () => "S" },
    { name: "description", uuid: SQL_NONE, overlay: { description: "D" }, path: "description", value: () => "D" },
    {
      name: "step description",
      uuid: SQL_NONE,
      overlay: { parsedSteps: [{ orderIndex: 2, description: "new" }] },
      path: "steps[1].description",
      value: () => "new",
    },
    {
      name: "CC source, plain stays plain",
      uuid: SQL_NONE,
      overlay: { parsedSteps: [{ orderIndex: 2, source: "console.log('x');" }] },
      path: "steps[1].properties.customCode.inlineCode",
      value: () => "console.log('x');",
    },
    {
      name: "CC source on a lean step (no id / apiId)",
      uuid: LEAN,
      overlay: { parsedSteps: [{ orderIndex: 3, source: "console.log(1)" }] },
      path: "steps[2].properties.customCode.inlineCode",
      value: () => "console.log(1)",
    },
    {
      name: "CC source, base64 stays base64",
      uuid: CC_B64,
      overlay: { parsedSteps: [{ orderIndex: 12, source: "console.log('b');" }] },
      path: "steps[11].properties.customCode.inlineCode",
      value: () => encodeBase64("console.log('b');"),
    },
    {
      name: "SQL, plain NONE slot stays plain",
      uuid: SQL_NONE,
      overlay: { parsedSteps: [{ orderIndex: 1, sql: "select 2" }] },
      path: "steps[0].inputs[0].properties[0].value",
      value: () => "select 2",
    },
    {
      name: "SQL, BASE_64 slot stays base64",
      uuid: SQL_B64,
      overlay: { parsedSteps: [{ orderIndex: 1, sql: "select 3" }] },
      path: "steps[0].inputs[0].properties[0].value",
      value: () => encodeBase64("select 3"),
    },
    {
      name: "SpEL echo expression",
      uuid: ECHO,
      overlay: { parsedSteps: [{ orderIndex: 2, expression: "#{a}" }] },
      path: "steps[1].inputs[0].value",
      value: () => "#{a}",
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const live = fresh(c.uuid);
      const plan = planV2Overlay(live, c.overlay);
      expect(diffPaths(live, plan.body)).toEqual([c.path]);
      expect(getAtPath(plan.body, c.path)).toEqual(c.value(live));
      expect(plan.targets).toEqual([{ key: plan.applied[0]!, path: c.path, value: c.value(live) }]);
    });
  }

  test("SQL slot path is the queryString the parser reads (key check)", () => {
    const live = fresh(SQL_B64);
    const plan = planV2Overlay(live, { parsedSteps: [{ orderIndex: 1, sql: "select 3" }] });
    expect((getAtPath(plan.body, "steps[0].inputs[0].properties[0]") as { key: string }).key).toBe("queryString");
    expect(decodeBase64Strict(getAtPath(plan.body, plan.targets[0]!.path) as string)).toBe("select 3");
  });

  test("an unchanged key next to a real change is reported, not refused", () => {
    const live = fresh(SQL_NONE);
    const plan = planV2Overlay(live, { description: live.description, summary: "new" });
    expect(plan.applied).toEqual(["summary"]);
    expect(plan.unchanged).toEqual(["description"]);
  });
});

describe("refusals", () => {
  const live = () => fresh(SQL_NONE);
  test.each([
    ["unknown top-level key", { foo: 1 }, "AD_OVERLAY_UNKNOWN_KEY"],
    ["unknown step key", { parsedSteps: [{ orderIndex: 1, code: "x" }] }, "AD_OVERLAY_UNKNOWN_KEY"],
    ["not an object", [1], "AD_OVERLAY_INVALID"],
    ["wrong type", { summary: 3 }, "AD_OVERLAY_INVALID"],
    ["empty name", { name: " " }, "AD_OVERLAY_INVALID"],
    ["non-integer orderIndex", { parsedSteps: [{ orderIndex: "1", description: "x" }] }, "AD_OVERLAY_INVALID"],
    ["buttonLabel (V2 drops it)", { buttonLabel: "Go" }, "AD_OVERLAY_NOT_APPLIED"],
    ["internalMethod (V2 drops it)", { internalMethod: true }, "AD_OVERLAY_NOT_APPLIED"],
    ["inputs[].testValue (dropped by every save)", { inputs: [{ code: "code", testValue: "x" }] }, "AD_OVERLAY_NOT_APPLIED"],
    ["missing orderIndex", { parsedSteps: [{ orderIndex: 99, description: "x" }] }, "AD_OVERLAY_NOT_APPLIED"],
    ["sql on a CC step", { parsedSteps: [{ orderIndex: 2, sql: "select 1" }] }, "AD_OVERLAY_NOT_APPLIED"],
    ["source on a SQL step", { parsedSteps: [{ orderIndex: 1, source: "x" }] }, "AD_OVERLAY_NOT_APPLIED"],
    ["expression on a non-echo step", { parsedSteps: [{ orderIndex: 1, expression: "#{a}" }] }, "AD_OVERLAY_NOT_APPLIED"],
    ["empty overlay", {}, "AD_OVERLAY_NOT_APPLIED"],
  ] as const)("%s → %s", (_n, overlay, expected) => {
    expect(code(() => planV2Overlay(live(), overlay))).toBe(expected);
  });

  test("a refusal lists every key that would not land", () => {
    try {
      planV2Overlay(live(), { buttonLabel: "x", parsedSteps: [{ orderIndex: 2, sql: "s" }] });
      throw new Error("no throw");
    } catch (e) {
      const d = (e as CliError).details as { notApplied: Array<{ key: string }> };
      expect(d.notApplied.map((n) => n.key)).toEqual(["buttonLabel", "parsedSteps[orderIndex=2].sql"]);
    }
  });
});
