// A8: every V2 save makes the server rewrite the method's test cases (it adds
// a raw `{}` for each input a case did not set and drops inputs the method no
// longer has). `ad save` snapshots the cases, PUTs the changed ones back
// (keeping only the removal of undeclared inputs) and reports `testCases`.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { runCommand, scratchDir, type RecordedRequest } from "@belzabar/core/testing";
import saveCommand from "../../commands/save/index";
import { planCaseRestores } from "../../lib/save/case-guard";
import { __setValidatorsForTests } from "../../lib/save/validation";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import { compiledCacheRoutes, fakeAdEnv, v2Store } from "./helpers/fake-ad";

const DIR = `${import.meta.dir}/../fixtures/real-v2`;
const U = "41bb1b438875bd8b994196db1f12b7c2"; // 2 cases: add_1 {code, stage_name, application_type}, Test {code, display_name (undeclared), application_type}
const ADD1 = "434c02222e6d27c8966889a1a74cf442";
const TEST = "4b361e021158c093232caef2c55fc6fb";
const base = (): V2MethodResponse => structuredClone(require(`${DIR}/${U}.v2.json`));

const ad = fakeAdEnv();
afterEach(() => {
  ad.restore();
  __setValidatorsForTests();
});

type Wire = { fieldCode: string; value: string; defaultValue?: string };
const cases = (b: unknown): any[] => (b as any).testSuite.testCases;
const inputsOf = (b: unknown, id: string): Record<string, string> =>
  Object.fromEntries((cases(b).find((c) => c.id === id).inputs as Wire[]).map((i) => [i.fieldCode, i.value]));

/** What the real server does to the suite on a V2 save (live 2026-11-18). */
function serverRewrite(body: V2MethodResponse, suite: unknown): V2MethodResponse {
  const declared = new Set((body.inputs ?? []).map((i: any) => i.key));
  const s = structuredClone(suite) as any;
  for (const c of s.testCases) {
    c.inputs = (c.inputs as Wire[]).filter((i) => declared.has(i.fieldCode));
    for (const k of declared) if (!c.inputs.some((i: Wire) => i.fieldCode === k)) c.inputs.push({ fieldCode: k, value: "{}" });
  }
  return { ...body, testSuite: s };
}

function wire() {
  const s = v2Store(U, base(), { onPost: (body) => serverRewrite(body, s.stored.testSuite) });
  const puts: Array<{ id: string; body: any }> = [];
  ad.install([
    ...s.routes,
    { method: "GET", url: `/rest/api/automation/chain/${U}`, response: { uuid: U, jsonDefinition: "{}" } },
    {
      method: "PUT",
      url: new RegExp(`/chain/testcases/${U}/`),
      response: (req: RecordedRequest) => {
        const id = req.url.split("/").pop()!;
        const body = req.json() as any;
        puts.push({ id, body });
        const c = cases(s.stored).find((x) => x.id === id);
        c.inputs = body.inputs;
        return { id };
      },
    },
    ...compiledCacheRoutes(),
  ]);
  return { s, puts };
}

function overlayFile(o: unknown): string {
  const p = join(scratchDir("ad-save-cases"), `o-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(o));
  return p;
}
/** A save that adds a method input: the server gives every case a {} for it. */
const ADD_INPUT = { ops: [{ op: "set-input", key: "newIn", type: "TEXT" }] };
const run = (overlay: unknown, ...extra: string[]) => runCommand(saveCommand, [overlayFile(overlay), "--uuid", U, "--yes", ...extra], { env: "t-dev" });

describe("planCaseRestores (pure)", () => {
  test("a {} the server added is dropped; an undeclared input it removed stays removed", () => {
    const before = base();
    const after = serverRewrite(base(), before.testSuite);
    const plan = planCaseRestores(before, after);
    expect(plan.map((p) => p.name)).toEqual(["Test"]);
    const t = plan[0]!.restore!;
    // stage_name {} dropped, display_name (not declared) stays dropped
    expect(Object.keys(t.inputs).sort()).toEqual(["application_type", "code"]);
  });

  test("a declared input the server removed comes back", () => {
    const before = base();
    const after = base();
    cases(after)[0].inputs = cases(after)[0].inputs.filter((i: Wire) => i.fieldCode !== "code");
    const [p] = planCaseRestores(before, after);
    expect(p!.id).toBe(ADD1);
    expect(Object.keys(p!.restore!.inputs).sort()).toEqual(["application_type", "code", "stage_name"]);
  });

  test("unchanged cases (re-spaced JSON included) need nothing; a missing case cannot be restored", () => {
    const after = base();
    cases(after)[0].inputs[0].value = '{"value":"Test"}';
    expect(planCaseRestores(base(), after)).toEqual([]);
    cases(after).splice(1, 1);
    expect(planCaseRestores(base(), after)).toEqual([{ id: TEST, name: "Test", restore: null, reason: "the case is gone after the write" }]);
  });

  test("a body without a testSuite field is not compared", () => {
    const after = base() as any;
    delete after.testSuite;
    expect(planCaseRestores(base(), after)).toEqual([]);
  });
});

describe("ad save restores the test cases the server rewrote (A8)", () => {
  test("PUTs every changed case back and reports testCases", async () => {
    const { s, puts } = wire();
    const r = await run(ADD_INPUT);
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope!.data as any).testCases).toEqual({
      changedByServer: ["configure.enrollment.stage.type.add_1", "Test"],
      restored: ["configure.enrollment.stage.type.add_1", "Test"],
      failed: [],
    });
    expect(puts.map((p) => p.id)).toEqual([ADD1, TEST]);
    expect(inputsOf(s.stored, ADD1)).toEqual({ code: '{"value":"Test"}', stage_name: '{"value":"Tenup Test Code"}', application_type: '{"value":"App Type"}' });
    // newIn / stage_name {} gone; display_name stays removed (the method does not declare it)
    expect(Object.keys(inputsOf(s.stored, TEST)).sort()).toEqual(["application_type", "code"]);
    expect(puts[1]!.body.inputs.map((i: Wire) => i.fieldCode)).toEqual(["application_type", "code"]);
    // the POST never carries the suite
    expect("testSuite" in s.posts[0]!).toBe(false);
  });

  test("--keep-case-changes reports without restoring", async () => {
    const { s, puts } = wire();
    const r = await run(ADD_INPUT, "--keep-case-changes");
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope!.data as any).testCases).toMatchObject({ changedByServer: ["configure.enrollment.stage.type.add_1", "Test"], restored: [], failed: [], kept: true });
    expect(puts).toHaveLength(0);
    expect(inputsOf(s.stored, TEST).newIn).toBe("{}");
  });

  test("a case that does not read back as restored is reported in failed", async () => {
    const { s } = wire();
    // the PUT answers 200 but stores nothing
    ad.install([
      ...s.routes,
      { method: "GET", url: `/rest/api/automation/chain/${U}`, response: { uuid: U, jsonDefinition: "{}" } },
      { method: "PUT", url: new RegExp(`/chain/testcases/${U}/`), response: () => ({}) },
      ...compiledCacheRoutes(),
    ]);
    const r = await run(ADD_INPUT);
    expect(r.envelope?.ok).toBe(true);
    const t = (r.envelope!.data as any).testCases;
    expect(t.restored).toEqual([]);
    expect(t.failed.map((f: any) => f.name)).toEqual(["configure.enrollment.stage.type.add_1", "Test"]);
    expect(t.failed[0].reason).toContain("reads back different");
    expect(((r.envelope!.meta as any)?.warnings ?? []).some((w: string) => w.includes("NOT restored"))).toBe(true);
  });
});
