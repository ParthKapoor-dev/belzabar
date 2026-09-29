// Stage 7.5 / 7.9: `child-info --shape`, `services --search` (fuzzy, compact
// rows, --fields) and `find --describe` (index schema 2), on real sems-dev
// fixtures through fakeFetch.
import { describe, expect, test } from "bun:test";
import { fakeFetch, fixture, respond, runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import childInfoCommand from "../../commands/child-info/index";
import servicesCommand, { rankServices } from "../../commands/services/index";
import findCommand from "../../commands/find/index";
import { accountLines, apiShape } from "../../lib/api-shape";
import { describeSearch, loadOrBuildMethodFinderIndex, METHOD_FINDER_SCHEMA, stepCallRefs } from "../../lib/method-finder";

const FIX = `${import.meta.dir}/../fixtures`;
const CI = `${FIX}/child-info`;
const EXAMPLE_CAT = "4423ad307059bc3fc6859804c9bd12e0"; // "Example services" on sems-dev
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };

describe("child-info --shape (7.5)", () => {
  test("db_service select: V2 key paths, BASE_64, enums, defaults, labels; hidden inputs counted", async () => {
    const shape = apiShape(await Bun.file(`${CI}/db_service__select.json`).json(), "db_service", "select");
    expect(shape.apiId).toBe(19);
    expect(shape.apiUuid).toBe("15805db3-0a4f-4f2a-80d8-c433a1ffeced");
    expect(shape.inputs).toContain("body.queryString STRING required BASE_64 (SQLQuery)");
    expect(shape.inputs).toContain("body.flatDataType STRING enum STRING|OBJECT|CSV default=STRING (responseDataType)");
    expect(shape.inputs).toContain("body.queryParams.test.type STRING enum STRING|OBJECT|TIMESTAMP|DATE|BOOLEAN|TEXT|NUMBER|FLOAT|ARRAY (parameterType)");
    expect(shape.inputs.some((l) => l.startsWith("body.requestTags"))).toBe(false); // showOnUi:false
    expect(shape.hiddenInputs).toBeGreaterThan(0);
    expect(shape.outputs).toContain("flatData[] ARRAY (responseJSON)");
    // the "This exactly / Step response" input-mode picker is not an enum
    expect(shape.inputs.find((l) => l.startsWith("body.input_1 "))).toBe("body.input_1 STRING (Input 1)");
    const all = apiShape(await Bun.file(`${CI}/db_service__select.json`).json(), "db_service", "select", { all: true });
    expect(all.inputs.some((l) => l.startsWith("body.requestTags"))).toBe(true);
    expect(all.hiddenInputs).toBeUndefined();
  });

  test("helper / user method: nested produces paths are not doubled; method uuid exposed", async () => {
    const helper = apiShape(await Bun.file(`${CI}/Helpers.JSON__fetchKeyValue.json`).json(), "Helpers.JSON", "fetchKeyValue");
    expect(helper.inputs).toEqual(["body OBJECT required", "body.json JSON required (inputJSON)", "body.path STRING"]);
    expect(helper.outputs).toEqual(["response JSON"]);
    expect(helper.alias).toBe("Select Element Based on Path");
    const user = apiShape(await Bun.file(`${CI}/Example_services__array_output.json`).json(), "Example services", "array output");
    expect(user.inputs).toEqual(["array ARRAY default=[1,2,3]", "array.aElement STRING"]);
    expect(user.methodUuid).toBe("48e5d8bec3f5d7b5d689914d3b36aed8");
  });

  test("accounts are id + nickname + scope only", async () => {
    const lines = accountLines(await Bun.file(`${CI}/auth-db_service.json`).json());
    expect(lines[0]).toBe("2 BCPS-RDS (ALL)");
    expect(lines.join("\n")).not.toMatch(/postgres|password|REDACTED/i);
  });

  test("command: --shape fetches contract + accounts; payload has no raw contract", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch({
      "GET /rest/api/automation-systems/db_service/automation-apis/select": fixture(`${CI}/db_service__select.json`),
      "GET /rest/api/automation-systems/db_service/auth": fixture(`${CI}/auth-db_service.json`),
    }).install();
    const r = await runCommand(childInfoCommand, ["db_service", "select", "--shape"], { env: "t-dev" });
    const data = r.envelope?.data as any;
    expect(data.view).toBe("shape");
    expect(data.body).toBeUndefined();
    expect(data.accounts).toHaveLength(8);
    expect(JSON.stringify(data).length).toBeLessThan(JSON.stringify(await Bun.file(`${CI}/db_service__select.json`).json()).length / 4);
    expect(ff.requests.map((q) => q.url.replace("https://t.test", ""))).toEqual([
      "/rest/api/automation-systems/db_service/automation-apis/select",
      "/rest/api/automation-systems/db_service/auth",
    ]);
  });

  test("--all without --shape is refused", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    const r = await runCommand(childInfoCommand, ["db_service", "select", "--all"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("INVALID_ARGUMENT");
  });
});

describe("services --search (7.5) and compact rows (7.9)", () => {
  const route = { "GET /rest/api/automation/services*": fixture(`${FIX}/categories/automation-services.json`) };

  test("fuzzy ranking: exact name first, typos still match", () => {
    const rows = [
      { name: "Helpers.JSON", label: "Helpers.JSON", aliasNames: [], description: "" },
      { name: "Helpers.Legacy", label: "Helpers.Legacy", aliasNames: [], description: "" },
      { name: "Cache.Redis", label: "Cache.Redis", aliasNames: [], description: "redis cache" },
    ];
    expect(rankServices(rows, "json")[0]!.name).toBe("Helpers.JSON");
    expect(rankServices(rows, "rediss")[0]!.name).toBe("Cache.Redis");
    expect(rankServices(rows, "zzzz")).toEqual([]);
  });

  test("command: ranked rows with score, top 20, compact fields", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(route).install();
    const r = await runCommand(servicesCommand, ["--search", "db_service"], { env: "t-dev" });
    const data = r.envelope?.data as any;
    expect(data.services[0]).toMatchObject({ name: "db_service", type: "SYSTEM_GENERATED" });
    expect(data.services[0].score).toBeGreaterThan(0);
    expect(data.services.length).toBeLessThanOrEqual(20);
    for (const s of data.services) {
      expect(s.uuid).toBeUndefined(); // not a default field
      expect(s.systemUuid).toBeUndefined();
    }
  });

  test("--fields picks; --fields all keeps full rows; unknown field fails", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(route).install();
    const picked = (await runCommand(servicesCommand, ["--fields", "name,uuid", "--limit", "3"], { env: "t-dev" })).envelope?.data as any;
    expect(picked.services).toHaveLength(3);
    for (const s of picked.services) expect(Object.keys(s).sort()).toEqual(["name", "uuid"]);
    const all = (await runCommand(servicesCommand, ["--fields", "all", "--limit", "1"], { env: "t-dev" })).envelope?.data as any;
    expect(Object.keys(all.services[0])).toContain("systemUuid");
    const bad = await runCommand(servicesCommand, ["--fields", "nope"], { env: "t-dev" });
    expect(bad.envelope?.error?.code).toBe("INVALID_VALUE");
  });

  test("default listing is much smaller than --fields all", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(route).install();
    const lean = JSON.stringify((await runCommand(servicesCommand, [], { env: "t-dev" })).envelope?.data).length;
    const full = JSON.stringify((await runCommand(servicesCommand, ["--fields", "all"], { env: "t-dev" })).envelope?.data).length;
    expect(lean).toBeLessThan(full * 0.6);
  });
});

describe("method index schema 2 + find --describe (7.5)", () => {
  function routes() {
    return {
      "GET /rest/api/automation/services*": respond({
        json: { result: [{ id: 40, uuid: `${EXAMPLE_CAT}    `, name: "Example services", label: "Example services" }] },
      }),
      [`GET /rest/api/automation/methods?categoryUuid=${EXAMPLE_CAT}*`]: fixture(`${FIX}/callers/methods-example-services.json`),
    };
  }

  test("records carry apiUuid, summary, call refs and opaque-step counts", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const { index } = await loadOrBuildMethodFinderIndex({ refresh: true });
    expect(index.schemaVersion).toBe(METHOD_FINDER_SCHEMA);
    const arrayOut = index.methods.find((m) => m.methodName === "array output")!;
    expect(arrayOut.automationApiUuid).toBe("45fe7e3d5d754cd67926a141c4faafe0");
    for (const m of index.methods) expect(Array.isArray(m.calls)).toBe(true);
    expect(index.methods.reduce((n, m) => n + (m.opaqueSteps ?? 0), 0)).toBeGreaterThan(0);
  });

  test("stepCallRefs: uuid refs, numeric ids, custom code skipped, automationId-only counted", () => {
    const refs = stepCallRefs({
      services: [
        { automationApiUuid: "ABC    ", automationId: 1 },
        { automationApiId: 19, automationId: 2 },
        { language: "JAVASCRIPT", code: "x", automationId: 3 },
        { automationId: 4 },
      ],
    });
    expect(refs).toEqual({ calls: ["u:abc", "n:19"], opaque: 1 });
  });

  test("an older (schema 1) cached index is rebuilt for --describe", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch(routes()).install();
    await loadOrBuildMethodFinderIndex({ refresh: true });
    const before = ff.requests.length;
    await loadOrBuildMethodFinderIndex({ refresh: false, minSchema: METHOD_FINDER_SCHEMA });
    expect(ff.requests.length).toBe(before); // schema 2 cache is reused
  });

  test("describeSearch ranks by words matched, then weighted score; --category narrows", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const { index } = await loadOrBuildMethodFinderIndex({ refresh: true });
    const hits = describeSearch(index, "chain failure", 5);
    expect(hits[0]!.methodName).toBe("testChainFailure");
    expect(hits[0]!.matched).toEqual(["chain", "failure"]);
    expect(describeSearch(index, "chain failure", 5, { category: "Helpers" })).toEqual([]);
    expect(describeSearch(index, "the of", 5)).toEqual([]); // stopwords only
  });

  test("command: find --describe returns compact rows; --describe without words fails", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const r = await runCommand(findCommand, ["--describe", "array", "output", "--refresh"], { env: "t-dev" });
    const data = r.envelope?.data as any;
    expect(data.mode).toBe("describe");
    expect(data.request).toBeUndefined();
    expect(data.matches[0]).toMatchObject({ name: "array output", category: "Example services", apiUuid: "45fe7e3d5d754cd67926a141c4faafe0" });
    expect(data.matches[0].url).toBeUndefined();
    const bad = await runCommand(findCommand, ["--describe"], { env: "t-dev" });
    expect(bad.envelope?.error?.code).toBe("MISSING_QUERY");
  });

  test("totalMatches counts every match; --limit caps only the rows (smoke envelope #9)", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const all = (await runCommand(findCommand, ["method", "--refresh", "--limit", "200"], { env: "t-dev" })).envelope?.data as any;
    expect(all.matches.length).toBeGreaterThan(2);
    expect(all.totalMatches).toBe(all.matches.length);
    const one = (await runCommand(findCommand, ["method", "--limit", "1"], { env: "t-dev" })).envelope?.data as any;
    expect(one.matches.length).toBe(1);
    expect(one.totalMatches).toBe(all.totalMatches);
    const d = (await runCommand(findCommand, ["--describe", "method", "--limit", "1"], { env: "t-dev" })).envelope?.data as any;
    expect(d.matches.length).toBe(1);
    expect(d.totalMatches).toBeGreaterThan(1);
  });

  test("command: plain search rows are compact and typed; --fields all keeps url", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const r = await runCommand(findCommand, ["chaining", "--refresh"], { env: "t-dev" });
    const m = (r.envelope?.data as any).matches[0];
    expect(m).toMatchObject({ type: "method", name: "chaining method", state: "DRAFT" });
    expect(m.url).toBeUndefined();
    const full = await runCommand(findCommand, ["chaining", "--fields", "all"], { env: "t-dev" });
    expect((full.envelope?.data as any).matches[0].url).toContain("/automation-designer/Example%20services/");
  });
});
