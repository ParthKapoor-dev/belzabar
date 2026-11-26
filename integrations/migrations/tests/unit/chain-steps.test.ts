// V2 chain steps for `migrate run`: batch members that call each other (H4,
// pre-flight warning + waves) and step inputs lost on the target (H5). Bodies
// follow the V2 wire shape (`/chain/v2/<uuid>?basicInfo=false`): steps carry
// serviceName / methodName / automationAPIId and inputs as key / value.
import { afterEach, describe, expect, test } from "bun:test";
import { fakeFetch, type FakeFetch, respond, type TempEnvConfig, withTempEnvConfig } from "@belzabar/core/testing";
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
  /** The target's automation-API lookups: system services exist, the batch's own callee does not (200, empty body). */
  const TARGET_APIS = [
    { url: "https://acme-qa.test/rest/api/automation-systems/Helpers.JSON/automation-apis/insertElement", response: { id: 1, uri: "insertElement" } },
    { url: "https://acme-qa.test/rest/api/automation-systems/db_service/automation-apis/data.read", response: { id: 2, uri: "data.read" } },
    { url: "https://acme-qa.test/rest/api/automation-systems/Cat-A/automation-apis/data.dataset.load", response: respond({ status: 200, text: "" }) },
  ];

  test("H4: the pre-flight warns about batch members that call each other and suggests waves", async () => {
    cfg = withTempEnvConfig({ envs, jenkins: { profileEnvs: { devacme: "acme-dev", qaacme: "acme-qa" } } });
    ff = fakeFetch([
      { url: `https://acme-dev.test/rest/api/automation/chain/${CALLER}`, response: { uuid: CALLER, name: "user.dashboard.getDetails" } },
      { url: `https://acme-dev.test/rest/api/automation/chain/${CALLEE}`, response: { uuid: CALLEE, name: "data.dataset.load" } },
      { url: `https://acme-dev.test/rest/api/automation/chain/v2/${CALLER}?basicInfo=false`, response: callerBody },
      { url: `https://acme-dev.test/rest/api/automation/chain/v2/${CALLEE}?basicInfo=false`, response: calleeBody },
      ...TARGET_APIS,
    ]).install();
    const warnings: string[] = [];
    const r = await resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "AD_Method", ids: [CALLER, CALLEE], warn: (m) => warnings.push(m) });
    expect(r?.waves).toEqual([[CALLEE], [CALLER]]);
    expect(r?.batchCalls).toHaveLength(1);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(`user.dashboard.getDetails (${CALLER}) step 2 calls data.dataset.load (${CALLEE})`);
    expect(warnings[0]).toContain(`1) ${CALLEE}  2) ${CALLER}`);
    // K18: the callee is new on the target, so the service would refuse the batch.
    expect(r?.calleeCheck).toEqual({
      targetEnv: "acme-qa",
      checked: 3,
      missing: [{ callee: "Cat-A/data.dataset.load", callers: [{ id: CALLER, name: "user.dashboard.getDetails", step: 2 }], inBatch: CALLEE }],
    });
    expect(warnings[1]).toContain("Not on 'acme-qa' (by category/name): Cat-A/data.dataset.load (called by user.dashboard.getDetails step 2; in this batch)");
    expect(warnings[1]).toContain("refuses the whole batch");
  });

  test("K18: called methods missing on the target are warned about; lookups that fail are listed, never thrown", async () => {
    cfg = withTempEnvConfig({ envs, jenkins: { profileEnvs: { devacme: "acme-dev", qaacme: "acme-qa" } } });
    ff = fakeFetch([
      { url: `https://acme-dev.test/rest/api/automation/chain/${CALLER}`, response: { uuid: CALLER, name: "user.dashboard.getDetails", automationState: "PUBLISHED" } },
      { url: `https://acme-dev.test/rest/api/automation/chain/v2/${CALLER}?basicInfo=false`, response: callerBody },
      { url: "https://acme-qa.test/rest/api/automation-systems/Helpers.JSON/automation-apis/insertElement", response: respond({ status: 500, json: {} }) },
      { url: "https://acme-qa.test/rest/api/automation-systems/Cat-A/automation-apis/data.dataset.load", response: respond({ status: 200, text: "" }) },
    ]).install();
    const warnings: string[] = [];
    const r = await resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "AD_Method", ids: [CALLER], warn: (m) => warnings.push(m) });
    expect(r?.calleeCheck?.missing).toEqual([{ callee: "Cat-A/data.dataset.load", callers: [{ id: CALLER, name: "user.dashboard.getDetails", step: 2 }] }]);
    expect(r?.calleeCheck?.errors).toEqual([{ callee: "Helpers.JSON/insertElement", error: "HTTP 500" }]);
    expect(warnings[0]).toContain("Cat-A/data.dataset.load (called by user.dashboard.getDetails step 2)");
    expect(warnings[0]).toContain("--migrate-dependents Y");
    expect(warnings[1]).toContain("could not look up Helpers.JSON/insertElement (HTTP 500)");
  });

  test("K18: the called-method check warns when the target env is not configured", async () => {
    cfg = withTempEnvConfig({ envs: { "acme-dev": envs["acme-dev"] }, jenkins: { profileEnvs: { devacme: "acme-dev", qaacme: "acme-qa" } } });
    ff = fakeFetch([
      { url: `https://acme-dev.test/rest/api/automation/chain/${CALLER}`, response: { uuid: CALLER, name: "user.dashboard.getDetails" } },
      { url: `https://acme-dev.test/rest/api/automation/chain/v2/${CALLER}?basicInfo=false`, response: callerBody },
    ]).install();
    const warnings: string[] = [];
    const r = await resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "AD_Method", ids: [CALLER], warn: (m) => warnings.push(m) });
    expect(r?.calleeCheck).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining("Called-method check skipped: target env 'acme-qa' is not configured")]);
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
