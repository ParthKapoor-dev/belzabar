// lib/validate L4 (online): service contract lookup and the gated dry-run
// compile, against fakeFetch + slim acme-dev captures
// (tests/fixtures/validate/online, read-only endpoints, see manifest.json).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Config } from "@belzabar/core";
import { fakeFetch, fixture, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { validateOnline, type ValidationResult } from "../../lib/validate/index";
import { buildDryRunPayload, DRY_RUN_GATE, dryRunExecutedSteps, type ApiContract } from "../../lib/validate/online";
import { golden, mutate } from "./validate-fixtures";

const ON = `${import.meta.dir}/../fixtures/validate/online`;
const API = "/rest/api/automation-systems";
let cfg: TempEnvConfig;
let ff: FakeFetch;
let testResponse: () => unknown = () => ({ debugResult: { services: [1, 2, 3].map((orderIndex) => ({ orderIndex, executionStatus: { executed: false, failed: false } })) } });

beforeEach(() => {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  ff = fakeFetch({
    [`GET ${API}/Helpers.Legacy/automation-apis/echo`]: fixture(`${ON}/api-echo.json`),
    [`GET ${API}/Helpers.Legacy/automation-apis/echoo`]: respond({ status: 200, text: "" }),
    [`GET ${API}/db_service/automation-apis/data.read`]: respond({ status: 200, text: "" }),
    [`GET ${API}/db_service/automation-apis/select`]: fixture(`${ON}/api-db-select.json`),
    [`GET ${API}/db_service/auth`]: fixture(`${ON}/auth-db_service.json`),
    [`GET ${API}/Helpers.JSON/automation-apis/fetchKeyValue`]: { id: 1, uuid: "4605d60e0435b82a15308a648810bae8    ", automationUserInputs: [] },
    [`GET ${API}/Broken.Svc/automation-apis/echo`]: respond({ status: 503, text: "down" }),
    "POST /rest/api/automation/chain/test": () => testResponse(),
  }).install();
});
afterEach(() => {
  ff.restore();
  cfg.restore();
});

const run = (after: unknown, extra: { dryRunCompile?: boolean; before?: unknown } = {}) =>
  validateOnline({ after: after as never, before: extra.before as never, env: "t-dev", dryRunCompile: extra.dryRunCompile });
const l4 = (r: ValidationResult) => [...r.errors, ...r.warnings].filter((f) => /^AD-(SVC|COMPILE)/.test(f.rule)).map((f) => `${f.rule}:${f.severity}:${f.path}`);

describe("L4 env handling", () => {
  test("runs on the requested env and restores the caller's env afterwards (it used to leak the switch)", async () => {
    cfg.restore();
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" }, "t-qa": { url: "https://t-qa.test" } }, activeEnv: "t-qa" });
    const hosts: string[] = [];
    ff.restore();
    ff = fakeFetch({ [`GET ${API}/Helpers.Legacy/automation-apis/echo`]: (req: Request) => { hosts.push(new URL(req.url).host); return fixture(`${ON}/api-echo.json`); } }).install();
    await run(golden()).catch(() => undefined);
    expect(hosts.length).toBeGreaterThan(0);
    expect(new Set(hosts)).toEqual(new Set(["t-dev.test"]));
    expect(Config.activeEnv.name).toBe("t-qa");
  });
});

describe("L4 service lookup", () => {
  test("golden: every step checked, no findings; db_service falls back from label to uri", async () => {
    const r = await run(golden());
    expect(l4(r)).toEqual([]);
    expect(r.layersRun).toEqual(["L1", "L2", "L3", "L4-service"]);
    const paths = ff.requests.map((q) => new URL(q.url).pathname);
    expect(paths).toContain(`${API}/db_service/automation-apis/data.read`);
    expect(paths).toContain(`${API}/db_service/automation-apis/select`);
  });

  test("wrong-case key with a matching uuid → AD-SVC-004 warn (server repairs, v2_step_input_key_wrongcase)", async () => {
    const r = await run(mutate((m) => { m.steps[0].inputs[0].key = "input"; }));
    expect(l4(r)).toEqual(["AD-SVC-004:warn:steps[0].inputs[0].key"]);
    expect(r.warnings.find((w) => w.rule === "AD-SVC-004")!.message).toContain('did you mean "Input"');
  });

  test("unknown key and no uuid → AD-SVC-003 error (input dropped, v2_step_input_key_unknown_no_uuid)", async () => {
    const r = await run(mutate((m) => { delete m.steps[0].inputs[0].uuid; m.steps[0].inputs[0].key = "bogusKey"; }));
    expect(l4(r)).toEqual(["AD-SVC-003:error:steps[0].inputs[0].key"]);
  });

  test("nested OBJECT inputs are checked against the nested contract (body.queryString)", async () => {
    const r = await run(mutate((m) => { const q = m.steps[2].inputs[0].properties[0]; q.key = "querystring"; delete q.uuid; }));
    expect(l4(r)).toEqual(["AD-SVC-003:error:steps[2].inputs[0].properties[0].key"]);
  });

  test("account id not in the service's auth list → AD-SVC-005 (v2_sql_bad_account: 500)", async () => {
    const r = await run(mutate((m) => { m.steps[2].accountConfiguration = { id: 999999, name: "nope" }; }));
    expect(l4(r)).toEqual(["AD-SVC-005:error:steps[2].accountConfiguration.id"]);
  });

  test("names that do not resolve, no id → AD-SVC-001 (v2_apiid_removed_names_wrong: 404)", async () => {
    const r = await run(mutate((m) => { delete m.steps[0].automationAPIId; m.steps[0].methodName = "echoo"; }));
    expect(l4(r)).toEqual(["AD-SVC-001:error:steps[0].methodName"]);
    expect(r.layersRun).toContain("L4-service(1/2)");
  });

  test("id and names disagree → AD-SVC-002 warn and the names' contract is not used", async () => {
    const r = await run(mutate((m) => { m.steps[0].serviceName = "Helpers.JSON"; m.steps[0].methodName = "fetchKeyValue"; }));
    expect(l4(r)).toEqual(["AD-SVC-002:warn:steps[0].automationAPIId"]);
  });

  test("lookup failure → AD-SVC-006 warn, partial layer", async () => {
    const r = await run(mutate((m) => { m.steps[0].serviceName = "Broken.Svc"; delete m.steps[0].automationAPIId; }));
    expect(l4(r)).toEqual(["AD-SVC-006:warn:steps[0].methodName"]);
    expect(r.layersRun.at(-1)).toBe("L4-service(1/2)");
  });

  test("diff-aware applies to L4 findings too", async () => {
    const before = mutate((m) => { m.steps[2].accountConfiguration = { id: 999999, name: "nope" }; });
    const r = await run(structuredClone(before), { before });
    expect(r.errors).toEqual([]);
  });
});

describe("L4 dry-run compile", () => {
  const contracts = async () => {
    const echo = (await Bun.file(`${ON}/api-echo.json`).json()) as ApiContract;
    const select = (await Bun.file(`${ON}/api-db-select.json`).json()) as ApiContract;
    return new Map<number, ApiContract>([[0, echo], [2, select]]);
  };

  test("payload: every step gated off, loops and async removed, ids from the contract", async () => {
    const body = mutate((m) => {
      m.steps[0].properties.runAsync = true;
      m.steps[0].properties.repeatStepExecution = { type: "LOOP_EXECUTION_ON_NUMBER", value: "3" };
    });
    const p = buildDryRunPayload(body as never, await contracts());
    expect(p.category).toEqual({ id: 1135, name: "Test-Tester" });
    const inner = JSON.parse(p.jsonDefinition as string);
    expect(inner.services.map((s: any) => [s.orderIndex, s.activeTab.id, s.conditionExpression, s.runAsync, s.repeatStepExecution])).toEqual([
      [1, "existingService", DRY_RUN_GATE, false, false],
      [2, "customCode", DRY_RUN_GATE, false, false],
      [3, "existingService", DRY_RUN_GATE, false, false],
    ]);
    const [echo, cc, sql] = inner.services;
    expect(echo.automationApiId).toBe(6501);
    expect(echo.mappings[0]).toMatchObject({ value: "Hello #{name}", automationUserInputId: 23538, combineInputs: true });
    expect(echo.outputs[0]).toMatchObject({ code: "greetingOut", outputCode: "response", automationAPIOutputId: 12908, internalVarRef: "greeting" });
    expect(cc).toMatchObject({ language: "JAVASCRIPT", customCodeEnv: "CODE_LAMBDA" });
    expect(sql).toMatchObject({ automationApiId: 19, automationAuthId: 2 });
    expect(sql.mappings[0].mappings[0]).toMatchObject({ automationUserInputId: 153, value: "select 1 as one, '#{name}' as nm" });
    expect(inner.inputs[0]).toMatchObject({ fieldCode: "name", required: false });
  });

  test("compiles, nothing executes → no finding; the POST is multipart in debug mode", async () => {
    const r = await run(golden(), { dryRunCompile: true });
    expect(l4(r)).toEqual([]);
    expect(r.layersRun).toEqual(["L1", "L2", "L3", "L4-service", "L4-compile"]);
    const post = ff.requests.find((q) => q.method === "POST")!;
    expect(post.headers["internal-ad-execution-mode"]).toBe("debug");
  });

  test("compile error → AD-COMPILE-001 error", async () => {
    testResponse = () => respond({ status: 400, json: { message: "Error while compiling automation", stackTrace: [] } });
    try {
      const r = await run(golden(), { dryRunCompile: true });
      expect(l4(r)).toEqual(["AD-COMPILE-001:error:"]);
    } finally {
      testResponse = () => ({ debugResult: { services: [] } });
    }
  });

  test("ADW-R11: any other non-2xx is a blocking AD-COMPILE-002 (was an AD-SVC-006 warning)", async () => {
    for (const resp of [
      () => respond({ status: 500, json: { errorMessage: "automationAPI is null" } }),
      () => respond({ status: 400, json: { message: "Invalid state, provided state does not match." } }),
      () => respond({ status: 502, text: "bad gateway" }),
    ]) {
      testResponse = resp;
      try {
        const r = await run(golden(), { dryRunCompile: true });
        expect(l4(r)).toEqual(["AD-COMPILE-002:error:"]);
        expect(r.errors.map((e) => e.rule)).toContain("AD-COMPILE-002");
      } finally {
        testResponse = () => ({ debugResult: { services: [] } });
      }
    }
  });

  test("a step that executed despite the gate is reported", () => {
    expect(dryRunExecutedSteps({ debugResult: { services: [{ orderIndex: 1, executionStatus: { executed: false } }, { orderIndex: 2, executionStatus: { executed: true } }] } })).toEqual([2]);
  });
});
