// V2 chain steps for `migrate run`: batch members that call each other (H4,
// pre-flight warning + waves) and step inputs lost on the target (H5). Bodies
// follow the V2 wire shape (`/chain/v2/<uuid>?basicInfo=false`): steps carry
// serviceName / methodName / automationAPIId and inputs as key / value.
import { afterEach, describe, expect, test } from "bun:test";
import { fakeFetch, type FakeFetch, type TempEnvConfig, withTempEnvConfig } from "@belzabar/core/testing";
import {
  batchCalls,
  checkTargetSteps,
  compareStepMappings,
  describeStepDifference,
  migrationWaves,
  resolveMigrationTargets,
  stepMappingsOf,
} from "../../lib";

const CALLER = "4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CALLEE = "4bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "4ccccccccccccccccccccccccccccccc";

const input = (key: string, value: string, properties: unknown[] = []) => ({ uuid: "u", key, name: key, value, type: "TEXT", properties });
const callStep = (service: string, method: string, api: string, inputs: unknown[]) => ({
  id: "x", automationAPIId: `${api}    `, serviceName: service, methodName: method, coreMethod: false,
  inputs, outputs: [], properties: { type: "EXISTING_SERVICE" },
});
const body = (uuid: string, name: string, api: string, steps: unknown[]) => ({
  uuid, name, automationApiId: api, metadata: { service: { name: "Cat-A" }, state: "PUBLISHED" }, steps,
});

const calleeBody = body(CALLEE, "data.dataset.load", "api-b", [callStep("db_service", "data.read", "x1", [input("body", "", [input("queryString", "SELECT 1")])])]);
const callerSteps = [
  callStep("Helpers.JSON", "insertElement", "x2", [input("json", "#{a}")]),
  callStep("Cat-A", "data.dataset.load", "api-b", [input("dataSetName", "#{name}"), input("replaceMissingWithNull", "true")]),
];
const callerBody = body(CALLER, "user.dashboard.getDetails", "api-a", callerSteps);
const otherBody = body(OTHER, "unrelated", "api-c", [callStep("Helpers.JSON", "insertElement", "x2", [])]);

describe("step mappings", () => {
  test("each step names its callee and flattens its inputs (nested properties as a.b; empty values dropped)", () => {
    expect(stepMappingsOf(calleeBody)).toEqual([
      { step: 1, callee: "db_service.data.read", service: "db_service", method: "data.read", api: "x1", inputs: { "body.queryString": "SELECT 1" } },
    ]);
  });

  test("H4: a member that calls another member is found (by category + name or API uuid); waves put callees first", () => {
    const bodies = new Map<string, any>([[CALLER, callerBody], [CALLEE, calleeBody], [OTHER, otherBody]]);
    const calls = batchCalls(bodies);
    expect(calls).toEqual([{ caller: CALLER, callerName: "user.dashboard.getDetails", step: 2, callee: CALLEE, calleeName: "data.dataset.load" }]);
    expect(migrationWaves([CALLER, CALLEE, OTHER], calls)).toEqual([[CALLEE, OTHER], [CALLER]]);
    // a cycle shares the last wave
    expect(migrationWaves(["a", "b"], [{ caller: "a", step: 1, callee: "b" }, { caller: "b", step: 1, callee: "a" }])).toEqual([["a", "b"]]);
  });

  test("H5: inputs the target lost are reported per step", () => {
    const lost = body(CALLER, "user.dashboard.getDetails", "api-a", [callerSteps[0], callStep("Cat-A", "data.dataset.load", "api-b", [])]);
    const diffs = compareStepMappings(callerBody, lost);
    expect(diffs).toEqual([{ step: 2, callee: "Cat-A.data.dataset.load", missing: ["dataSetName", "replaceMissingWithNull"] }]);
    expect(describeStepDifference(diffs[0]!)).toBe("step 2 (Cat-A.data.dataset.load) missing on target: dataSetName, replaceMissingWithNull");
    expect(compareStepMappings(callerBody, callerBody)).toEqual([]);
    expect(compareStepMappings(callerBody, body(CALLER, "n", "api-a", [callerSteps[0]]))).toEqual([
      { step: 2, callee: "Cat-A.data.dataset.load", note: "step missing on the target" },
    ]);
  });
});

describe("over a faked env", () => {
  let cfg: TempEnvConfig | null = null;
  let ff: FakeFetch | null = null;
  afterEach(() => {
    ff?.restore();
    ff = null;
    cfg?.restore();
    cfg = null;
  });
  const envs = { "acme-dev": { url: "https://acme-dev.test" }, "acme-qa": { url: "https://acme-qa.test" } };

  test("H4: the pre-flight warns about batch members that call each other and suggests waves", async () => {
    cfg = withTempEnvConfig({ envs, jenkins: { profileEnvs: { devacme: "acme-dev", qaacme: "acme-qa" } } });
    ff = fakeFetch([
      { url: `https://acme-dev.test/rest/api/automation/chain/${CALLER}`, response: { uuid: CALLER, name: "user.dashboard.getDetails" } },
      { url: `https://acme-dev.test/rest/api/automation/chain/${CALLEE}`, response: { uuid: CALLEE, name: "data.dataset.load" } },
      { url: `https://acme-dev.test/rest/api/automation/chain/v2/${CALLER}?basicInfo=false`, response: callerBody },
      { url: `https://acme-dev.test/rest/api/automation/chain/v2/${CALLEE}?basicInfo=false`, response: calleeBody },
    ]).install();
    const warnings: string[] = [];
    const r = await resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "AD_Method", ids: [CALLER, CALLEE], warn: (m) => warnings.push(m) });
    expect(r?.waves).toEqual([[CALLEE], [CALLER]]);
    expect(r?.batchCalls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`user.dashboard.getDetails (${CALLER}) step 2 calls data.dataset.load (${CALLEE})`);
    expect(warnings[0]).toContain(`1) ${CALLEE}  2) ${CALLER}`);
  });

  test("H5: checkTargetSteps reports a migrated caller whose target step lost its inputs", async () => {
    cfg = withTempEnvConfig({ envs });
    const lost = body(CALLER, "user.dashboard.getDetails", "api-a", [callerSteps[0], callStep("Cat-A", "data.dataset.load", "api-b", [])]);
    ff = fakeFetch([
      { url: `https://acme-dev.test/rest/api/automation/chain/v2/${CALLER}?basicInfo=false`, response: callerBody },
      { url: `https://acme-qa.test/rest/api/automation/chain/v2/${CALLER}?basicInfo=false`, response: lost },
      { url: `https://acme-dev.test/rest/api/automation/chain/v2/${CALLEE}?basicInfo=false`, response: calleeBody },
      { url: `https://acme-qa.test/rest/api/automation/chain/v2/${CALLEE}?basicInfo=false`, response: calleeBody },
    ]).install();
    const check = await checkTargetSteps([CALLER, CALLEE], "acme-dev", "acme-qa");
    expect(check.methods).toEqual([
      { id: CALLER, name: "user.dashboard.getDetails", differences: [{ step: 2, callee: "Cat-A.data.dataset.load", missing: ["dataSetName", "replaceMissingWithNull"] }] },
    ]);
    expect(check.errors).toBeUndefined();
    expect((await checkTargetSteps([CALLER], "acme-dev", "acme-stage")).skipped).toContain("'acme-stage' not configured");
  });
});
