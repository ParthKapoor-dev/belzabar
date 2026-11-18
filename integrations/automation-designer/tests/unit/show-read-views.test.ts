// Read-view fixes: `ad show` --step N (D1), cache freshness (D2), cuts (D3),
// method description (D4/B124), stable shapes (D5), defaults (D27), scope
// (D30), --version N (D31) and canonical callee categories (D36).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { fakeFetch, respond, runCommand, withTempEnvConfig, type RecordedRequest } from "@belzabar/core/testing";
import showCommand from "../../commands/show/index";
import { adApi } from "../../lib/api/index";
import { CacheManager } from "../../lib/cache";
import { categoryResolverFor } from "../../lib/method-finder";
import { compactMethod, compactStepLine, stepGates, storedSummaryOf, storyMarkdown } from "../../lib/method-view";
import { parseV1Method } from "../../lib/parser/v1";
import { parseV2Method } from "../../lib/parser/v2";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import type { HydratedMethod } from "../../lib/types/common";

const FIX = `${import.meta.dir}/../fixtures`;
const SQL_UUID = "41bb1b438875bd8b994196db1f12b7c2";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

async function v2Raw(uuid = SQL_UUID): Promise<V2MethodResponse> {
  return (await Bun.file(`${FIX}/real-v2/${uuid}.v2.json`).json()) as V2MethodResponse;
}

/** A small V2 body exercising the read-view cases. */
function body(over: Partial<Record<string, unknown>> = {}): V2MethodResponse {
  const longWhen = `#{name != null && name != '${"a".repeat(80)}' && name != '${"b".repeat(80)}'}`;
  return {
    uuid: "4bd184c20140dd9fb25493eb3e95227d",
    name: "m.readviews",
    summary: "",
    description: "Long method description.",
    metadata: { version: { name: "3" }, state: "DRAFT", service: { id: 1, uuid: "c1", name: "Sandbox" } },
    permissions: { permissionSet: [], methodScope: null, allowedCategories: [] },
    inputs: [
      { key: "name", name: "name", type: "STRING" },
      { key: "size", name: "size", type: "JSON", defaultValue: '{"size":200}' },
    ],
    variables: [{ key: "filterClauseFinal", name: "filterClauseFinal", type: "TEXT", defaultValue: "1=1" }],
    outputs: [{ key: "response", name: "response", type: "STRING" }],
    steps: [
      {
        description: `returns {<settingName>: value} ${"x".repeat(120)}`,
        serviceName: "Helpers.Legacy",
        methodName: "echo",
        automationAPIId: "424ffd4c9e0f55befc238dd999dab2d6    ",
        inputs: [{ key: "Input", value: `#{name} ${"y".repeat(200)}` }],
        outputs: [{ key: "response", fieldCode: "response", name: "response" }],
        properties: {
          type: "EXISTING_SERVICE",
          entryCondition: { expression: longWhen },
          exitCondition: { exitOnFailure: { value: true, code: null, message: "" }, conditionalExit: { code: null, message: "", expression: null } },
        },
      },
      {
        serviceName: "Schools - Utilities",
        methodName: "array.to.string",
        automationAPIId: "477fa1feedcc5ae84fa484b49a62a1a7",
        inputs: [{ key: "arrayString", value: "#{size}" }],
        outputs: [{ key: "outputString", fieldCode: "joined", name: "joined" }],
        properties: { type: "EXISTING_SERVICE", exitCondition: { exitOnFailure: { value: true } } },
      },
    ],
    ...over,
  } as unknown as V2MethodResponse;
}
const parsed = (over?: Partial<Record<string, unknown>>) => parseV2Method(body(over), { env: "t-dev" });

const resolver = categoryResolverFor({
  categories: [
    { uuid: "cu", name: "Schools-Utilities", label: "Schools-Utilities", aliasNames: ["Schools - Utilities"], methodCount: 1 },
    { uuid: "ch", name: "Helpers.Legacy", label: "Helpers.Legacy", aliasNames: ["Helper Methods"], methodCount: 1 },
    { uuid: "x1", name: "Documents.Word", label: "Documents.Word", aliasNames: ["Microsoft Office"], methodCount: 1 },
    { uuid: "x2", name: "Documents.Excel", label: "Documents.Excel", aliasNames: ["Microsoft Office"], methodCount: 1 },
  ],
});

async function show(method: HydratedMethod, argv: string[]) {
  using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
  spies.push(
    spyOn(adApi, "fetchMethod").mockResolvedValue(method),
    spyOn(CacheManager, "loadSwr").mockResolvedValue(null),
    spyOn(CacheManager, "save").mockResolvedValue(undefined),
  );
  return await runCommand(showCommand, [method.uuid, "--v2", ...argv], { env: "t-dev" });
}

describe("D3: cuts", () => {
  test("conditions are never cut; every other cut says use --full", () => {
    const m = parsed();
    const gates = stepGates(m.parsedSteps[0]!);
    expect(gates[0]).toBe(`when ${m.parsedSteps[0]!.conditionExpression}`);
    const line = compactStepLine(m.parsedSteps[0]!);
    expect(line).toContain(`when ${m.parsedSteps[0]!.conditionExpression}`);
    expect(line).toMatch(/…\(\+\d+, use --full\)"/); // the description
    expect(line).toMatch(/\| = #\{name\} y+…\(\+\d+, use --full\) \|/); // the echo body
  });
  test("--compact --step N prints that step whole", async () => {
    const data = (await show(parsed(), ["--compact", "--step", "1"])).envelope?.data as any;
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]).not.toContain("…(+");
    expect(data.steps[0]).toContain("y".repeat(200));
  });
});

describe("D4 / B124: summary and methodDescription by their real names", () => {
  test("compact, story and the default view", async () => {
    const m = parsed();
    expect(m.summary).toBe("Long method description."); // the display fallback stays for other callers
    const view = compactMethod(m);
    expect(view.summary).toBeUndefined();
    expect(view.methodDescription).toBe("Long method description.");
    expect(compactMethod(parsed({ summary: "Short." })).summary).toBe("Short.");
    const md = storyMarkdown(m);
    expect(md).toContain("**What it does:** (no summary)\n**Description (methodDescription):** Long method description.");
    const data = (await show(m, [])).envelope?.data as any;
    expect(data.summary.summary).toBe("");
    expect(data.summary.methodDescription).toBe("Long method description.");
  });
  test("an older cached parse (no storedSummary) drops the description fallback", () => {
    const m = { ...parsed(), storedSummary: undefined };
    expect(storedSummaryOf(m)).toBe("");
    expect(storedSummaryOf({ ...m, summary: "Real.", description: "Other." })).toBe("Real.");
  });
  test("V1: methodDescription is the description, summary is the summary", async () => {
    const raw = await Bun.file(`${FIX}/real-v1/4a49e392ca76084725c3839ff97007ae.v1.json`).json();
    const m = parseV1Method(raw);
    expect(m.storedSummary).toBe("");
    expect(compactMethod(m).methodDescription).toStartWith("This method will be asked by PAGE");
    expect(compactMethod(m).summary).toBeUndefined();
  });
});

describe("D5: shapes do not depend on the method", () => {
  test("--compact --sql on a method without SQL still has blocks: []", async () => {
    const data = (await show(parsed(), ["--compact", "--sql"])).envelope?.data as any;
    expect(data.blocks).toEqual([]);
    const plain = (await show(parsed(), ["--compact"])).envelope?.data as any;
    expect(plain.blocks).toBeUndefined();
  });
  test("a stepless (built-in) method shows its inputs and outputs without flags", async () => {
    const data = (await show(parsed({ steps: [] }), [])).envelope?.data as any;
    expect(data.steps).toEqual([]);
    expect(data.inputs.map((i: any) => i.code)).toEqual(["name", "size"]);
    expect(data.outputs.map((o: any) => o.code)).toEqual(["response"]);
    expect(data.note).toContain("built-in");
  });
});

describe("D27: defaults", () => {
  test("compact `defaults`, default-view defaultValue, story Default column", async () => {
    const m = parsed();
    expect(compactMethod(m).defaults).toEqual({ inputs: { size: '{"size":200}' }, variables: { filterClauseFinal: "1=1" } });
    const data = (await show(m, ["--inputs", "--variables"])).envelope?.data as any;
    expect(data.inputs.find((i: any) => i.code === "size").defaultValue).toBe('{"size":200}');
    expect(data.variables[0]).toMatchObject({ code: "filterClauseFinal", defaultValue: "1=1" });
    const md = storyMarkdown(m);
    expect(md).toContain('| size | JSON | {"size":200} |  |');
    expect(md).toContain("| filterClauseFinal | TEXT | 1=1 |");
  });
});

describe("D30: scope is shown for every method", () => {
  test("an unset V2 methodScope reads as UNRESTRICTED, like the V1 route", () => {
    expect(compactMethod(parsed()).flags).toBe("scope UNRESTRICTED");
    expect(compactMethod(parsed({ permissions: { methodScope: "INTERNAL" } })).flags).toBe("scope INTERNAL");
    expect(compactMethod(parsed({ permissions: undefined })).flags).toBeUndefined();
  });
});

describe("D36: callee categories are canonical", () => {
  test("aliases and `A - B` spellings resolve; ambiguous aliases do not", () => {
    expect(resolver("Schools - Utilities")).toEqual({ name: "Schools-Utilities", uuid: "cu" });
    expect(resolver("schools-utilities")).toEqual({ name: "Schools-Utilities", uuid: "cu" });
    expect(resolver("Helpers.Legacy")).toEqual({ name: "Helpers.Legacy", uuid: "ch" });
    expect(resolver("Microsoft Office")).toBeUndefined();
    expect(resolver("Nope")).toBeUndefined();
  });
  test("step lines and `callees` carry the canonical name and the api uuid", () => {
    const view = compactMethod(parsed(), { categoryOf: resolver });
    expect(view.steps[1]).toStartWith("2 CALL Schools-Utilities.array.to.string");
    expect(view.callees).toContainEqual({ step: 2, category: "Schools-Utilities", categoryUuid: "cu", method: "array.to.string", apiUuid: "477fa1feedcc5ae84fa484b49a62a1a7" });
    expect(storyMarkdown(parsed(), { categoryOf: resolver })).toContain("| 2 | Schools-Utilities/array.to.string |");
    expect(compactMethod(parsed()).steps[1]).toStartWith("2 CALL Schools - Utilities.array.to.string"); // no index: as on the wire
  });
});

describe("D1: --step N answers with that step", () => {
  test("no other steps, the body and the bound inputs of every kind", async () => {
    const m = parseV2Method(await v2Raw(), { env: "t-dev" });
    const data = (await show(m, ["--step", "4"])).envelope?.data as any;
    expect(data.steps).toBeUndefined();
    expect(data.allStepDetails).toBeUndefined();
    expect(data.stepDetail.orderIndex).toBe(4);
    expect(data.stepDetail.inputs).toEqual([{ input: "display_name", value: "#{stage_name}" }]);
    const sql = (await show(m, ["--step", "1"])).envelope?.data as any;
    expect(sql.stepDetail.sql).toContain("select * from enrollment_stage_type");
  });
});

describe("D31: --version N reads that version through history", () => {
  test("the view is built from the history body, with its record", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const current = parsed();
    spies.push(spyOn(adApi, "fetchMethod").mockResolvedValue(current));
    const get = spyOn(adApi, "historyGet").mockResolvedValue({
      methodID: current.uuid,
      methodVersion: 2,
      methodVersionID: "vid-2",
      isPublished: false,
      isDeactivated: false,
      addedBy: 7,
      addedWhen: "2026-01-01 10:00:00",
      jsonDefinition: { ...body(), steps: [body().steps![1]], summary: "Old summary." },
    });
    spies.push(get);
    const r = await runCommand(showCommand, [current.uuid, "--v2", "--version", "2", "--compact"], { env: "t-dev" });
    const data = r.envelope?.data as any;
    expect(get.mock.calls[0]![0]).toMatchObject({ category: "Sandbox", methodName: "m.readviews", version: 2, includeDraft: true });
    expect(data.source).toBe("history");
    expect(data.history).toMatchObject({ version: 2, side: "DRAFT", addedWhen: "2026-01-01 10:00:00" });
    expect(data.version).toBe(2);
    expect(data.steps).toHaveLength(1);
    expect(data.summary).toBe("Old summary.");
    expect(data.uuid).toBe(current.uuid);
  });
  test("--version with --force is refused", async () => {
    const r = await runCommand(showCommand, ["4bd184c20140dd9fb25493eb3e95227d", "--version", "2", "--force"]);
    expect(r.envelope?.ok).toBe(false);
  });
});

describe("D2: a cached copy is checked against the server's version", () => {
  const UUID = "40b7959fb1dd8b4cf2ee9f5e54630ea8"; // every service definition is a fixture, so the parse is cached
  const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };
  const v1 = JSON.parse(readFileSync(`${FIX}/real-v1/${UUID}.v1.json`, "utf8"));
  const v2 = JSON.parse(readFileSync(`${FIX}/real-v2/${UUID}.v2.json`, "utf8"));
  const routes = (version: number) => [
    { method: "GET", url: `/rest/api/automation/chain/${UUID}`, response: { ...v1, version } },
    { method: "GET", url: new RegExp(`/chain/v2/${UUID}`), response: v2 },
    {
      method: "GET",
      url: /\/rest\/api\/automations\/(\d+)/,
      response: (req: RecordedRequest) => {
        const f = `${FIX}/definitions/${/automations\/(\d+)/.exec(req.url)![1]}.json`;
        return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : respond({ status: 404, text: "" });
      },
    },
  ];

  test("same version: served from cache with its age; newer on the server: read fresh with a warning", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    {
      using _ff = fakeFetch(routes(4)).install();
      expect((await runCommand(showCommand, [UUID, "--force"], { env: "t-dev" })).envelope?.ok).toBe(true); // cached now
      const hit = await runCommand(showCommand, [UUID], { env: "t-dev" });
      const data = hit.envelope?.data as any;
      expect(data.source).toBe("cache");
      expect(data.cache).toMatchObject({ version: 4, serverVersion: 4, ageMinutes: 0 });
    }
    {
      using _ff = fakeFetch(routes(5)).install();
      const r = await runCommand(showCommand, [UUID], { env: "t-dev" });
      const data = r.envelope?.data as any;
      expect(data.source).toBe("fresh");
      expect(data.summary.version).toBe(5);
      expect(data.cache).toBeUndefined();
      expect(JSON.stringify(r.envelope?.meta)).toContain("Cached copy was v4");
    }
  });

  test("--step N never uses the cache", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch(routes(4)).install();
    await runCommand(showCommand, [UUID, "--force"], { env: "t-dev" });
    const before = ff.requests.length;
    const r = await runCommand(showCommand, [UUID, "--step", "1"], { env: "t-dev" });
    expect((r.envelope?.data as any).source).toBe("fresh");
    expect(ff.requests.slice(before).some((q) => q.url.includes(`/chain/${UUID}`))).toBe(true);
  });
});
