// What only the V1 body holds (lib/v1-only.ts), on a real pair of bodies of one
// method (tests/fixtures/legacy-loop): step 2 loops over #{list} in V1 the way
// the older editor stored it (loopExecutionSource only), and the V2 GET shows
// no loop for it.
//   K1: `ad show` shows the loop; `ad save` carries it into the V2 body.
//   K5: V1 mappings of callee inputs that no longer exist are listed as dropped;
//       removing such an input by its old code is accepted.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import saveCommand from "../../commands/save/index";
import showCommand from "../../commands/show/index";
import { parseV1Method } from "../../lib/parser/v1";
import { compactStepLine } from "../../lib/method-view";
import { planV2Overlay } from "../../lib/serialize/v2";
import { emptyCatalog } from "../../lib/serialize/compact";
import { carryLegacyLoops, droppedMappings, legacyLoops, mappingCandidates, v1Definition, v2EachLoop } from "../../lib/v1-only";
import type { ApiContract } from "../../lib/validate/online";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import { compiledCacheRoutes, fakeAdEnv, v2Store } from "./helpers/fake-ad";

const FIX = `${import.meta.dir}/../fixtures/legacy-loop`;
const v1Raw = (): any => structuredClone(require(`${FIX}/v1.json`));
const v2Raw = (): V2MethodResponse => structuredClone(require(`${FIX}/v2.json`));
const U = String(v2Raw().uuid).trim();
const LOOP = v2EachLoop("#{list}");
const def1 = (raw: unknown = v1Raw()): any => v1Definition(raw);

describe("legacy loops (K1)", () => {
  test("the fixture: V1 loops step 2 (source only), V2 has no loop there", () => {
    const svc = def1().services[1];
    expect([svc.loopExecutionSource, svc.repeatStepExecution ?? null, svc.loopConfiguration ?? null]).toEqual(["#{list}", null, null]);
    expect(v2Raw().steps![1]!.properties!.repeatStepExecution ?? null).toBeNull();
    expect(legacyLoops(v1Definition(v1Raw()), v2Raw().steps)).toEqual([{ step: 2, over: "#{list}" }]);
  });

  test("the V1 parse shows it as a loop (default `ad show`)", () => {
    const m = parseV1Method(v1Raw(), { resolveService: () => null });
    const s = m.parsedSteps[1]!;
    expect([s.repeatStepExecution, s.loopExecutionSource, s.loopConfiguration?.type, s.legacyLoop]).toEqual([true, "#{list}", "LOOP_EXECUTION_ON_INPUT_OUTPUT", true]);
    expect(compactStepLine(s)).toContain("loop each #{list} (v1 only)");
    expect(m.parsedSteps[0]!.repeatStepExecution).toBeFalsy();
  });

  test("a step whose V2 body already loops, or a V1 step that says repeatStepExecution false, is not carried", () => {
    const v2 = v2Raw();
    v2.steps![1]!.properties!.repeatStepExecution = LOOP as never;
    expect(legacyLoops(v1Definition(v1Raw()), v2.steps)).toEqual([]);
    const def = def1();
    def.services[1].repeatStepExecution = false;
    expect(legacyLoops(def, v2Raw().steps)).toEqual([]);
    // step counts differ: no positional match, nothing carried
    expect(legacyLoops(v1Definition(v1Raw()), v2Raw().steps!.slice(0, 1))).toEqual([]);
  });

  test("a leaf overlay carries it as a verified target", () => {
    const live = v2Raw();
    const p = planV2Overlay(live, { description: "x" });
    expect(carryLegacyLoops(p, legacyLoops(v1Definition(v1Raw()), live.steps), {})).toEqual([{ step: 2, over: "#{list}" }]);
    expect(p.body.steps![1]!.properties!.repeatStepExecution).toEqual(LOOP as never);
    expect(p.targets.at(-1)).toEqual({ key: "loop carried: step 2", path: "steps[1].properties.repeatStepExecution", value: LOOP });
  });

  test("ops: carried at the step's new position; not when the ops remove it or set / clear its loop", () => {
    const live = v2Raw();
    const loops = legacyLoops(v1Definition(v1Raw()), live.steps);
    const moved = { ops: [{ op: "move-step", step: 2, before: 1 }] };
    const p = planV2Overlay(live, moved, { catalog: emptyCatalog() });
    expect(carryLegacyLoops(p, loops, moved)).toHaveLength(1);
    expect(p.body.steps![0]!.properties!.repeatStepExecution).toEqual(LOOP as never);
    expect(p.structural!.touched).toContain("steps[0].properties.repeatStepExecution");
    for (const ops of [[{ op: "remove-step", step: 2 }], [{ op: "update-step", step: 2, set: { loop: null, description: "d" } }]]) {
      const q = planV2Overlay(v2Raw(), { ops }, { catalog: emptyCatalog() });
      expect(carryLegacyLoops(q, loops, { ops })).toEqual([]);
    }
  });
});

describe("dropped input mappings (K5)", () => {
  // Step 2 (a call) gets a V1 mapping for input #4454, which its callee no longer has.
  const withDangling = () => {
    const raw = v1Raw();
    const def = def1(raw);
    def.services[1].mappings.push({ automationUserInputUuid: "4bdbed41fb6a5e7f8e93a0a9554329fa    ", automationUserInputId: 4454, value: "#{oldId}", mappings: [] });
    raw.jsonDefinition = JSON.stringify(def);
    return raw;
  };
  const kept = def1().services[1].mappings[0];
  const contract: ApiContract = { automationUserInputs: [{ id: kept.automationUserInputId, uuid: "0000000000000000000000000000aaaa", produces: "versionId" }] };

  test("listed from the callee contract: only the input it no longer has", () => {
    const steps = v2Raw().steps;
    const cands = mappingCandidates(v1Definition(withDangling()), steps);
    expect(cands.map((c) => c.step)).toEqual([2]);
    expect(droppedMappings(cands, steps, () => contract)).toEqual([{ step: 2, input: "#4454", value: "#{oldId}" }]);
    // no contract: nothing named reliably (V1 and V2 input uuids differ), so nothing listed
    expect(droppedMappings(cands, steps, () => undefined)).toEqual([]);
    expect(mappingCandidates(v1Definition(v1Raw()), steps)).toEqual([]);
  });

  test("removing it by its old code (or #id) is accepted; an input the callee has but the step lacks is still refused", () => {
    const live = v2Raw();
    const catalog = emptyCatalog();
    catalog.contracts.set("Sample methods/performDbUpdate", { automationUserInputs: [{ id: 1, produces: "versionId" }, { id: 2, produces: "other" }] });
    for (const key of ["programGradeId", "#4454"]) {
      const p = planV2Overlay(live, { ops: [{ op: "update-step", step: 2, set: { inputs: { [key]: null } } }] }, { catalog });
      expect(p.applied[0]).toContain(`-inputs.${key} (not an input of the callee`);
      expect(p.body).toEqual(live);
    }
    expect(() => planV2Overlay(live, { ops: [{ op: "update-step", step: 2, set: { inputs: { other: null } } }] }, { catalog })).toThrow("the step has no input 'other' to remove");
  });
});

describe("end to end (fake env)", () => {
  const ad = fakeAdEnv();
  afterEach(() => ad.restore());
  const V1_GET = `/rest/api/automation/chain/${U}`;

  function wire(v1 = v1Raw()) {
    const s = v2Store(U, v2Raw());
    ad.install([s.routes[0]!, s.routes[1]!, { method: "GET", url: V1_GET, response: () => v1 }, ...compiledCacheRoutes()]);
    return s;
  }
  const overlay = (o: unknown) => {
    const p = join(scratchDir("ad-v1-only"), `o-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(o));
    return p;
  };

  test("show --compact marks the V1-only loop and says so", async () => {
    wire();
    const r = await runCommand(showCommand, [U, "--compact"], { env: "t-dev" });
    const steps = (r.envelope!.data as any).steps as string[];
    expect(steps[1]).toContain("loop each #{list} (v1 only)");
    expect(((r.envelope!.meta?.warnings ?? []) as string[]).some((w) => w.includes("loop in the V1 body only"))).toBe(true);
  });

  test("save --dry-run lists the carried loop; the save stores it and verifies it", async () => {
    const s = wire();
    const dry = await runCommand(saveCommand, [overlay({ description: "touch" }), "--uuid", U, "--dry-run"], { env: "t-dev" });
    const d = dry.envelope!.data as any;
    expect(d.loopsCarried).toEqual([{ step: 2, over: "#{list}" }]);
    expect(d.changes.map((c: any) => c.path)).toContain("steps[1].properties.repeatStepExecution");
    expect(d.droppedMappings).toEqual([]);
    const r = await runCommand(saveCommand, [overlay({ description: "touch" }), "--uuid", U, "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope!.data as any).loopsCarried).toEqual([{ step: 2, over: "#{list}" }]);
    expect(s.stored.steps![1]!.properties!.repeatStepExecution).toEqual(LOOP as never);
  });
});
