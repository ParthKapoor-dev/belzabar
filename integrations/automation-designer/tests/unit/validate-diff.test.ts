// lib/validate — diff-aware severity, strict mode, overlay paths, the
// calibration over the 36 real sems-dev bodies, and the §4 catalogue map.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { RULES, alignSteps, validateMethodV2 } from "../../lib/validate/index";
import { CASES, caseBody, golden, mutate, realV2 } from "./validate-fixtures";

const PAIRS_DIR = `${import.meta.dir}/../fixtures/draft-published`;
/** The 8 real sems-dev draft/published pairs (their step ids all differ). */
function draftPublishedPairs(): Array<{ name: string; draft: any; published: any }> {
  const read = (f: string) => JSON.parse(readFileSync(`${PAIRS_DIR}/${f}`, "utf8"));
  return readdirSync(PAIRS_DIR)
    .filter((f) => f.endsWith(".published.v2.json"))
    .sort()
    .map((f) => {
      const published = read(f);
      return { name: f.slice(0, 8), published, draft: read(`${published.metadata.referenceId}.draft.v2.json`) };
    });
}

describe("diff-aware", () => {
  test("a finding already in `before` is a pre-existing warning; a new one blocks", () => {
    const before = caseBody("v2_spel_dangling_ref");
    const after = structuredClone(before) as any; // `any`: test mutation of the wire body
    after.steps[2].inputs[0].properties[0].value = "select #{ghostTwo}";
    const r = validateMethodV2({ after, before });
    const pre = r.warnings.find((w) => w.rule === "AD-REF-001" && w.path === "steps[0].inputs[0].value");
    expect(pre?.preexisting).toBe(true);
    expect(r.errors.map((e) => `${e.rule} ${e.path}`)).toEqual(["AD-REF-001 steps[2].inputs[0].properties[0].value"]);
  });

  test("fingerprints follow the step id, not the index (inserting a step keeps old findings pre-existing)", () => {
    const before = caseBody("v2_spel_dangling_ref");
    const after = structuredClone(before) as any; // `any`: test mutation of the wire body
    after.steps.unshift(structuredClone(after.steps[2]));
    after.steps[0].id = "4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1    ";
    after.steps[0].outputs[0].fieldCode = "sqlRows2";
    after.steps[0].outputs[0].name = "sqlRows2";
    const r = validateMethodV2({ after, before });
    const moved = r.warnings.find((w) => w.rule === "AD-REF-001");
    expect(moved?.path).toBe("steps[1].inputs[0].value");
    expect(moved?.preexisting).toBe(true);
  });

  test("ADW-R3: a DIFFERENT broken body at the same path is new and blocks", () => {
    const before = caseBody("v2_cc_syntax_error");
    const same = validateMethodV2({ after: structuredClone(before), before });
    expect(same.errors).toEqual([]);
    const after = structuredClone(before) as any; // `any`: test mutation of the wire body
    after.steps[1].properties.customCode.inlineCode = "function broken( { return";
    const r = validateMethodV2({ after, before });
    expect(r.errors.map((e) => e.rule)).toContain("AD-CC-001");
  });

  test("ADW-R3: a different dangling #{ref} at the same input is new", () => {
    const before = caseBody("v2_spel_dangling_ref");
    const after = structuredClone(before) as any; // `any`: test mutation of the wire body
    const v = after.steps[0].inputs[0].value as string;
    after.steps[0].inputs[0].value = v.replace(/#\{(\w+)\}/, "#{otherGhost}");
    expect(after.steps[0].inputs[0].value).not.toBe(v);
    const r = validateMethodV2({ after, before });
    expect(r.errors.some((e) => e.rule === "AD-REF-001" && e.path === "steps[0].inputs[0].value")).toBe(true);
  });

  test("ADW-R3: a new unbound output that lands on an old unbound output's index is new", () => {
    const before = mutate((m) => m.outputs.unshift({ key: "ghost", fieldCode: "ghost", name: "ghost", type: "STRING", description: "" }));
    const after = structuredClone(before) as any; // `any`: test mutation of the wire body
    after.outputs[0] = { key: "ghost2", fieldCode: "ghost2", name: "ghost2", type: "STRING", description: "" };
    const pre = validateMethodV2({ after: structuredClone(before), before });
    expect(pre.warnings.some((w) => w.rule === "M3" && w.preexisting)).toBe(true);
    const r = validateMethodV2({ after, before });
    const m3 = [...r.errors, ...r.warnings].filter((f) => f.rule === "M3");
    expect(m3.map((f) => [f.path, !!f.preexisting])).toEqual([["outputs[0].key", false]]);
  });

  test("ADW-R3: removing an earlier output does not turn an old finding into a new one", () => {
    const before = mutate((m) => m.outputs.push({ key: "ghost", fieldCode: "ghost", name: "ghost", type: "STRING", description: "" }));
    const after = structuredClone(before) as any; // `any`: test mutation of the wire body
    after.outputs.splice(0, 1); // ghost moves from outputs[3] to outputs[2]
    const r = validateMethodV2({ after, before });
    const m3 = [...r.errors, ...r.warnings].filter((f) => f.rule === "M3" && f.path.endsWith(".key"));
    expect(m3.map((f) => [f.path, f.preexisting])).toEqual([["outputs[2].key", true]]);
  });

  test("ADW-R4: steps align by position/service when the ids differ (draft vs published)", () => {
    for (const { name, draft, published } of draftPublishedPairs()) {
      const map = alignSteps(published, draft);
      expect({ name, map }).toEqual({ name, map: draft.steps.map((_s: unknown, i: number) => i) });
    }
    // an inserted step in the middle does not shift the pairing of the others
    const before = golden() as any; // `any`: test mutation of the wire body
    const after = structuredClone(before);
    after.steps.forEach((s: any, i: number) => (s.id = `x${i}`));
    after.steps.splice(1, 0, structuredClone(after.steps[0]));
    expect(alignSteps(before, after)).toEqual([0, -1, 1, 2]);
  });

  test("ADW-R4: every real draft validated against its published copy has only pre-existing findings", () => {
    let preexisting = 0;
    for (const { name, draft, published } of draftPublishedPairs()) {
      const r = validateMethodV2({ after: draft, before: published });
      expect({ name, errors: r.errors }).toEqual({ name, errors: [] });
      expect({ name, allPre: r.warnings.every((w) => w.preexisting) }).toEqual({ name, allPre: true });
      preexisting += r.warnings.length;
    }
    expect(preexisting).toBeGreaterThan(0); // e.g. 438b5027's CI1 inputs are matched across different step ids
  });

  test("ADW-R4: a new error in a draft is still new against the published copy", () => {
    const { draft, published } = draftPublishedPairs().find((p) => p.name === "41f705af")!;
    const after = structuredClone(draft);
    after.outputs.push({ key: "ghostOut", name: "ghostOut", type: "STRING" });
    const r = validateMethodV2({ after, before: published });
    expect([...r.errors, ...r.warnings].some((f) => f.rule === "M3" && !f.preexisting)).toBe(true);
  });

  test("strict turns new warnings into errors but leaves pre-existing ones as warnings", () => {
    const before = golden();
    const after = mutate((m) => { m.steps[0].id = "step-1"; });
    const r = validateMethodV2({ after, before, strict: true });
    expect(r.errors.map((e) => e.rule)).toEqual(["S2"]);
    expect(r.warnings.map((w) => [w.rule, w.preexisting])).toEqual([["AD-SQL-004", true]]);
  });

  test("overlayPaths flags new findings outside the edited paths as possible drift", () => {
    const after = caseBody("v2_spel_nested");
    const inside = validateMethodV2({ after, before: golden(), overlayPaths: ["steps[0].inputs"] });
    expect(inside.errors[0]!.message).not.toContain("drift");
    const outside = validateMethodV2({ after, before: golden(), overlayPaths: ["description"] });
    expect(outside.errors[0]!.message).toContain("possible serializer drift");
  });
});

describe("calibration: 36 real sems-dev V2 bodies", () => {
  const bodies = realV2();
  test("36 fixtures", () => expect(bodies.length).toBe(36));

  test("validated against themselves: 0 errors", () => {
    for (const { file, body } of bodies) {
      const r = validateMethodV2({ after: body, before: body });
      expect({ file, errors: r.errors }).toEqual({ file, errors: [] });
      expect(r.warnings.every((w) => w.preexisting)).toBe(true);
    }
  });

  // Raw findings (no `before`) — every one was reviewed against the body (2026-09-28):
  // real problems or rules the team treats as errors on authored methods. The count is
  // pinned so a rule change that adds false positives shows up here.
  test("documented raw finding count", () => {
    const counts: Record<string, number> = {};
    for (const { body } of bodies) {
      const r = validateMethodV2({ after: body });
      for (const f of [...r.errors, ...r.warnings]) counts[`${f.rule}:${f.severity}`] = (counts[`${f.rule}:${f.severity}`] ?? 0) + 1;
    }
    expect(counts).toEqual({
      "AD-GRAPH-006:warn": 2, // two drafts with no steps
      "AD-META-001:error": 8, // the 8 PUBLISHED records (a save body must be a draft)
      "AD-OUT-001:error": 3, // 472f8572: three custom-code steps with an empty output
      "AD-OUT-002:error": 3,
      "AD-REF-001:error": 1, // 422a34a9: #{epStartDate} is never defined
      "AD-REF-002:warn": 1, // 4540d7de: step 4 reads #{docCodeId} it writes itself
      "AD-SCHEMA-003:warn": 8, // the non-hex output uuid …6a00e5g copied between methods
      "AD-SPEL-001:error": 3, // 43818593: entry conditions with an unclosed #{
      "AD-SQL-004:warn": 37, // #{…} spliced into SQL (common style)
      "CC3:warn": 4, // custom code that never prints
      "CI1:error": 58, // SpEL with combineInput:false (team rule; UI cannot run these)
      "CO1:error": 3, // STRIING
      "CO2:error": 3,
      "DUP1:error": 5, // duplicate output names/fieldCodes (3 methods)
      "M1:error": 5, // method names with spaces ("Copy of …")
      "OK1:error": 2, // method outputs with fieldCode but no key
      "Q5:error": 1, // 422a34a9: ’CHOICE_APPLICATION’ curly quotes in SQL
      "SP1:warn": 1,
      "SV1:error": 2, // inputReference to an undeclared variable
    });
  });
});

// Every row of research/ad-validation.md §4 → the rule that catches it (tested in
// validate-l1/-rules/-online tests) or why it is out of the validator's scope.
const CATALOGUE_4: Array<[string, string]> = [
  // 4.1 rejected by the server
  ["step missing properties", "S1"],
  ["properties.type not in enum", "S1"],
  ["step output fieldCode ''", "AD-OUT-001"],
  ["step output fieldCode null", "AD-OUT-001"],
  ["step output name with a space", "NC1"],
  ["V1 output code ''", "AD-OUT-001 (V2 analog: save is V2)"],
  ["method input key na-me", "IK1"],
  ["variable key greet.ing", "VK1"],
  ["method name with a space", "M1"],
  ["inputReference ''", "AD-SCHEMA-001"],
  ["bogus automationAPIId", "AD-SVC-002 / AD-COMPILE-002 (L4)"],
  ["wrong serviceName/methodName", "AD-SVC-001 (L4)"],
  ["CC language / executor not in enum", "CC1 / CC5"],
  ["method/input output type FOO", "AD-SCHEMA-002"],
  ["accountConfiguration.id that does not exist", "AD-SVC-005 (L4)"],
  ["outputRef.referenceStepIndex out of range", "AD-GRAPH-003"],
  ["exitOnFailure.value 'yes'", "AD-SCHEMA-001"],
  ["thin V2 update", "AD-META-002"],
  ["metadata.state PUBLISHED in body", "AD-META-001"],
  ["V1 jsonDefinition sent as an object", "M2 (not a V2 body)"],
  ["V1 jsonDefinition invalid JSON", "N/A: the command rejects unparseable JSON before validating; save is V2"],
  ["V1 step missing activeTab", "S1 (V2 analog: properties)"],
  ["V1 category.id = categories-listing id", "N/A: V1 save only; V2 resolves metadata.service by name"],
  ["V1 save of a lean chain", "N/A: V2 accepts lean chains (D1)"],
  ["changelog entry without user", "N/A: publish/changelog path (5A)"],
  // 4.2 accepted and broken afterwards
  ["serializer re-encodes plain CC code", "N/A here: L0 round-trip invariant in the save pipeline (5A)"],
  ["overlay fields not persisted", "N/A here: L0 effect check in the save pipeline (5A)"],
  ["overlay sql/expression no-op on sems-dev", "N/A here: L0 effect check (5A); classification by service identity (4A)"],
  ["method output with no key", "OK1"],
  ["method output nothing writes", "M3"],
  ["input renamed while steps use #{name}", "AD-REF-001"],
  ["SpEL dangling reference", "AD-REF-001"],
  ["SpEL syntax error / nested / brace literal", "AD-SPEL-005 / AD-SPEL-002 / AD-SPEL-004"],
  ["unclosed #{name", "AD-SPEL-001"],
  ["inputReference to an undeclared variable", "SV1"],
  ["V1 internalVarRef to an undeclared variable", "SV1 (V2 analog)"],
  ["entry condition unknown variable / plain text", "CR1 / AD-COND-001"],
  ["entry condition syntax error", "AD-SPEL-005"],
  ["basic rows disagree with expression", "AD-COND-002"],
  ["duplicate step id / V1 automationId", "S3"],
  ["duplicate step-output fieldCode", "DUP1"],
  ["CC multi-output without elementToRetrieve", "AD-CC-002 (+ AD-CC-003 key==fieldCode)"],
  ["CC single output with non-matching elementToRetrieve", "AD-CC-004"],
  ["CC language null", "CC1"],
  ["CC syntax error", "AD-CC-001"],
  ["SQL base64 without the flag", "SQL1"],
  ["SQL step with no accountConfiguration", "AD-SQL-002"],
  ["SQL syntax error", "N/A: no SQL parser (optional per research); AD-SQL-003/Q1/Q5 lint the common cases"],
  ["V1 step bound to the wrong apiId", "AD-SVC-002 (L4)"],
  ["V1 duplicate orderIndex", "N/A: V2 steps are ordered by array position"],
  ["V1 orderIndex gap or 0-based", "N/A: V2 steps are ordered by array position"],
  ["V1 mapping missing automationUserInputId and Uuid", "AD-SVC-003 (V2 analog, L4)"],
  ["V2 input with unknown key and no uuid", "AD-SVC-003 (L4)"],
  ["reader before writer", "AD-REF-002"],
  ["loop.type not recognised", "LP1"],
  ["loop ON_INPUT_OUTPUT without value", "LP2"],
  ["runAsync step writes a method output", "AS1"],
  ["defaultValue #{name}", "AD-SPEL-006"],
  ["combineInput:false holding SpEL", "CI1"],
  ["empty steps", "AD-GRAPH-006"],
  ["duplicate input keys / variable same key as input", "AD-GRAPH-001 / AD-GRAPH-002"],
  ["V1 stale version", "N/A here: L0 freshness re-GET in the save pipeline (5A)"],
  ["publish of any of the above", "N/A here: publish runs validateMethodV2 (5A)"],
];

describe("§4 failure catalogue", () => {
  test("every row maps to a catalogued rule or a stated reason", () => {
    for (const [row, target] of CATALOGUE_4) {
      if (target.startsWith("N/A")) continue;
      const codes = (target.match(/\b(?:AD-[A-Z]+-\d{3}|[A-Z]{1,3}\d)\b/g) ?? []).filter((c) => !/^[VL]\d$/.test(c));
      expect({ row, codes: codes.length > 0 }).toEqual({ row, codes: true });
      for (const c of codes) expect({ row, c, known: c in RULES }).toEqual({ row, c, known: true });
    }
    expect(CATALOGUE_4.length).toBe(63);
  });

  test("every live case the server rejected is caught offline or needs L4", () => {
    const needsL4 = new Set(["v2_apiid_bogus", "v2_apiid_removed_names_wrong", "v2_sql_bad_account"]);
    for (const [name, c] of Object.entries(CASES)) {
      if (!/HTTP (4|5)\d\d/.test(c.save.join(" ")) || needsL4.has(name)) continue;
      const r = validateMethodV2({ after: caseBody(name) });
      expect({ name, blocked: r.errors.length > 0 }).toEqual({ name, blocked: true });
    }
  });

  test("every rule in the catalogue has a description and layer", () => {
    for (const [code, info] of Object.entries(RULES)) {
      expect({ code, ok: info.description.length > 10 && /^L[1-4]$/.test(info.layer) }).toEqual({ code, ok: true });
    }
  });
});
