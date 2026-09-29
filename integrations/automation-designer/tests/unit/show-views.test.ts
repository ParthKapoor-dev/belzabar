// `ad show --compact` / `--story` and the lean default envelope,
// over the 36 real acme-dev V2 bodies (+ V1 with definition labels).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync } from "fs";
import { runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import showCommand, { parseMethodFile, stepTableRows } from "../../commands/show/index";
import { adApi } from "../../lib/api/index";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { abbreviate, pruneEmpty } from "../../lib/compact";
import { compactMethod, compactStepLine, renderCompact, stepFacts, storyMarkdown } from "../../lib/method-view";
import { parseV1Method } from "../../lib/parser/v1";
import { parseV2Method } from "../../lib/parser/v2";
import type { V1AutomationDefinition, V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import type { HydratedMethod } from "../../lib/types/common";
import { parseFieldList, projectRow } from "@belzabar/core";

const FIX = `${import.meta.dir}/../fixtures`;
const V2_FILES = readdirSync(`${FIX}/real-v2`).filter((f) => f.endsWith(".v2.json"));
const SQL_UUID = "41bb1b438875bd8b994196db1f12b7c2"; // 11 steps: SQL, JS code, service calls, conditions
const LOOP_UUID = "486041dfd02d9fd45a27b608ad2dce0c"; // loops, SpEL, conditional exit, variable writes

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

async function v2Raw(uuid: string): Promise<V2MethodResponse> {
  return (await Bun.file(`${FIX}/real-v2/${uuid}.v2.json`).json()) as V2MethodResponse;
}
async function v2(uuid: string): Promise<HydratedMethod> {
  return parseV2Method(await v2Raw(uuid), { env: "acme-dev" });
}

function stub(method: HydratedMethod) {
  spies.push(
    spyOn(adApi, "fetchMethod").mockResolvedValue(method),
    spyOn(CacheManager, "loadSwr").mockResolvedValue(null),
    spyOn(CacheManager, "save").mockResolvedValue(undefined),
  );
}

async function show(method: HydratedMethod, argv: string[]) {
  using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
  stub(method);
  return await runCommand(showCommand, [method.uuid, "--v2", ...argv], { env: "t-dev" });
}

describe("compact helpers", () => {
  test("pruneEmpty drops null/''/[]/{} recursively but keeps false and 0", () => {
    expect(pruneEmpty<unknown>({ a: null, b: "", c: [], d: {}, e: false, f: 0, g: [{ x: "" }, { y: 1 }], h: { i: { j: null } } })).toEqual({
      e: false,
      f: 0,
      g: [{ y: 1 }],
    });
  });
  test("abbreviate collapses whitespace and marks the cut", () => {
    expect(abbreviate("select *\n  from   t", 0)).toBe("select * from t");
    expect(abbreviate("abcdefghij", 4)).toBe("abcd…(+6)");
  });
  test("--fields: default / pick / all, unknown → INVALID_VALUE", () => {
    const full = { name: "n", id: 1, empty: "", extra: "x" };
    expect(projectRow(full, parseFieldList(undefined, ["name", "id", "extra"]), ["name", "id", "empty"])).toEqual({ name: "n", id: 1 });
    expect(projectRow(full, parseFieldList("extra", ["name", "id", "extra"]), ["name"])).toEqual({ extra: "x" });
    expect(projectRow(full, parseFieldList("all", ["name"]), ["name"])).toBe(full);
    expect(() => parseFieldList("nope", ["name"])).toThrow(/unknown field/);
  });
});

describe("ad show default envelope is lean", () => {
  test("no request echo, no badge duplicate, no empty fields, bodies only on demand", async () => {
    const r = await show(await v2(SQL_UUID), ["--services"]);
    const data = r.envelope?.data as any;
    expect(data.request).toBeUndefined();
    expect(data.raw).toBeUndefined();
    expect(data.stepDetail).toBeUndefined(); // null → pruned
    for (const s of data.steps) expect(s.badge).toBeUndefined();
    const sqlDetail = data.allStepDetails.find((d: any) => d.kind === "SQL");
    expect(sqlDetail.sql).toBeUndefined(); // --services alone: no SQL body
    const code = data.allStepDetails.find((d: any) => d.kind === "CUSTOM_CODE");
    expect(code.source).toBeUndefined();
    expect(JSON.stringify(data)).not.toMatch(/:(null|""|\[\]|\{\})[,}]/);
  });

  test("--sql / --code include the decoded bodies", async () => {
    const data = (await show(await v2(SQL_UUID), ["--sql", "--code"])).envelope?.data as any;
    expect(data.allStepDetails.find((d: any) => d.kind === "SQL").sql).toContain("enrollment_stage_type");
    expect(data.allStepDetails.find((d: any) => d.kind === "CUSTOM_CODE").source).toContain("codeNotExist");
  });

  test("--service-detail N always carries that step's body", async () => {
    const data = (await show(await v2(SQL_UUID), ["--step", "1"])).envelope?.data as any;
    expect(data.stepDetail.sql).toContain("enrollment_stage_type");
  });

  test("--raw emits the wire body exactly once", async () => {
    const raw = await v2Raw(SQL_UUID);
    const data = (await show(parseV2Method(raw, { env: "acme-dev" }), ["--raw"])).envelope?.data as any;
    expect(data.raw).toEqual(raw);
    const text = JSON.stringify(data);
    // the step's first uuid appears once (in raw) — the parsed view no longer repeats wire JSON
    const stepId = String((raw as any).steps[0].id).trim();
    expect(text.split(stepId).length - 1).toBe(1);
  });
});

describe("ad show --compact", () => {
  test("one line per step with decoded SQL/code, conditions and outputs", async () => {
    const m = await v2(SQL_UUID);
    const data = (await show(m, ["--compact"])).envelope?.data as any;
    expect(data.view).toBe("compact");
    expect(data.steps).toHaveLength(m.parsedSteps.length);
    for (const line of data.steps) expect(line).not.toContain("\n");
    const acct = m.parsedSteps[0]!.account?.name;
    expect(acct).toBeTruthy();
    expect(data.steps[0]).toBe(
      `1 SQL db_service.data.read | when #{code} ne null | sql: select * from enrollment_stage_type where code = '#{code}'; | -> flatData[]→enrollment_stage_type_info, rowsImpacted→enrollment_stage_type_count | account ${acct}`,
    );
    expect(data.steps[1]).toStartWith("2 CODE(javascript) | when #{code} ne null | code: if('#{enrollment_stage_type_count}' != 0)");
    expect(data.steps[3]).toBe("4 CALL Schools-Utilities.find.initials.from.string | when #{code} eq null | display_name=#{stage_name} | -> response→stage_name_initials");
    expect(data.in).toBe("code:STRING, stage_name:STRING, application_type:STRING");
    expect(data.blocks).toBeUndefined();
  });

  test("loops, SpEL, conditional exit and variable writes come from the V2 wire", async () => {
    const m = await v2(LOOP_UUID);
    const lines = compactMethod(m).steps;
    expect(lines[0]).toContain("-> response→typeConfig1⇒$typeConfig");
    expect(lines[3]).toContain("loop each #{enabledFeatures}");
    expect(lines[3]).toContain("exit-if #{enabledFeatures[2].overridden} == 'f'");
    expect(lines[1]).toContain('| = { "displayName": #{featureConfig.display_name}');
    expect(stepFacts(m.parsedSteps[3]!).loop).toEqual({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", over: "#{enabledFeatures}", counter: undefined, parallel: undefined });
  });

  test("--sql / --code put full bodies in blocks; --step N narrows to one step", async () => {
    const m = await v2(SQL_UUID);
    const d1 = (await show(m, ["--compact", "--sql"])).envelope?.data as any;
    expect(d1.blocks.map((b: any) => b.kind)).toEqual(["SQL", "SQL", "SQL", "SQL", "SQL"]);
    const d2 = (await show(m, ["--compact", "--step", "2"])).envelope?.data as any;
    expect(d2.steps).toHaveLength(1);
    expect(d2.blocks).toEqual([{ step: 2, kind: "CODE", language: "JAVASCRIPT", text: expect.stringContaining("codeNotExist") }]);
    expect(renderCompact(d2)).toContain("--- step 2 CODE (javascript) ---");
  });

  test("V1 parses get input labels from the service definitions", async () => {
    const raw = (await Bun.file(`${FIX}/real-v1/${SQL_UUID}.v1.json`).json()) as V1RawMethodResponse;
    const m = parseV1Method(raw);
    const defs = new Map<string, V1AutomationDefinition>();
    for (const f of readdirSync(`${FIX}/definitions`).filter((f) => /^\d+\.json$/.test(f))) {
      defs.set(f.replace(".json", ""), (await Bun.file(`${FIX}/definitions/${f}`).json()) as V1AutomationDefinition);
    }
    spies.push(spyOn(ServiceHydrator, "getDefinition").mockImplementation(async (id: string | number) => defs.get(String(id)) ?? null));
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    stub(m);
    const data = (await runCommand(showCommand, [SQL_UUID, "--compact"], { env: "t-dev" })).envelope?.data as any;
    expect(data.steps).toHaveLength(11);
    const call = data.steps.find((l: string) => l.includes("display_name="));
    expect(call).toBeDefined(); // label from the definition, not `#<id>`
  });

  test("compact is far smaller than the raw wire over all 36 real bodies", async () => {
    let raw = 0;
    let compact = 0;
    for (const f of V2_FILES) {
      const body = await Bun.file(`${FIX}/real-v2/${f}`).json();
      raw += JSON.stringify(body).length;
      compact += JSON.stringify(pruneEmpty(compactMethod(parseV2Method(body, { env: "acme-dev" })))).length;
    }
    expect(compact / raw).toBeLessThan(0.15);
  });

  test("every real body renders without throwing and keeps one line per step", async () => {
    for (const f of V2_FILES) {
      const m = parseV2Method(await Bun.file(`${FIX}/real-v2/${f}`).json(), { env: "acme-dev" });
      for (const s of m.parsedSteps) expect(compactStepLine(s)).not.toContain("\n");
      expect(storyMarkdown(m)).toStartWith(`## ${m.name}`);
    }
  });
});

// the agent views read V2 so their keys are the ones `ad save` ops take.
describe("ad show --compact / --story read V2", () => {
  test("without --v2 the views fetch V2, fresh, and say so", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const m = await v2(SQL_UUID);
    const fetch = spyOn(adApi, "fetchMethod").mockResolvedValue(m);
    const load = spyOn(CacheManager, "loadSwr").mockResolvedValue(null);
    spies.push(fetch, load);
    for (const view of ["--compact", "--story"]) {
      const d = (await runCommand(showCommand, [SQL_UUID, view], { env: "t-dev" })).envelope?.data as any;
      expect(d).toMatchObject({ source: "fresh", sourceVersion: "v2", fetchedAt: expect.any(String) });
    }
    expect(fetch.mock.calls.map((c) => c[1])).toEqual(["v2", "v2"]);
    expect(load).not.toHaveBeenCalled();
  });

  test("a V2 refusal falls back to V1 with a warning; an unknown uuid still fails", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const { CliError } = await import("@belzabar/core");
    const m1 = parseV1Method((await Bun.file(`${FIX}/real-v1/${SQL_UUID}.v1.json`).json()) as V1RawMethodResponse);
    let notFound = false;
    const fetch = spyOn(adApi, "fetchMethod").mockImplementation(async (_u: string, v: string) => {
      if (notFound) throw new CliError("gone", { code: "METHOD_NOT_FOUND" });
      if (v === "v2") throw new CliError("400", { code: "API_ERROR" });
      return m1;
    });
    spies.push(fetch, spyOn(ServiceHydrator, "getDefinition").mockResolvedValue(null));
    const r = await runCommand(showCommand, [SQL_UUID, "--compact"], { env: "t-dev" });
    expect((r.envelope?.data as any).sourceVersion).toBe("v1");
    expect(((r.envelope?.meta?.warnings ?? []) as string[]).join("\n")).toMatch(/V2 read failed/);
    notFound = true;
    expect((await runCommand(showCommand, [SQL_UUID, "--compact"], { env: "t-dev" })).envelope?.error?.code).toBe("METHOD_NOT_FOUND");
  });

  test("over every real V2 body, compact input names are wire keys, never `#<id>` labels", async () => {
    for (const f of V2_FILES) {
      const m = parseV2Method(await Bun.file(`${FIX}/real-v2/${f}`).json(), { env: "acme-dev" });
      for (const line of compactMethod(m).steps) expect(line).not.toMatch(/(^|[ ,|])#\d+\./);
    }
  });
});

describe("ad show --story", () => {
  test("renders the approval template with decoded code and SQL", async () => {
    const m = await v2(SQL_UUID);
    const data = (await show(m, ["--story"])).envelope?.data as any;
    expect(data.view).toBe("story");
    const md: string = data.markdown;
    expect(md).toStartWith("## configure.enrollment.stage.type.add.old\n");
    expect(md).toContain("**What it does:** Enrollment Stage Type Add");
    expect(md).toContain("**Approach:** mixed (11 steps: 1 custom code, 10 service calls)");
    expect(md).toContain("**Service:** Schools");
    expect(md).toContain("| Field | Type | Test value | Purpose |");
    expect(md).toContain("| # | Type | What it does |");
    const acct = (await v2(SQL_UUID)).parsedSteps[0]!.account?.name;
    expect(md).toContain(`| 1 | db_service/data.read (SQL read) | only when #{code} ne null; gives \`enrollment_stage_type_info\`, \`enrollment_stage_type_count\`; uses account ${acct} |`);
    expect(md).toContain("### Custom code (Step 2) — javascript\n```javascript\n");
    expect(md).toContain("### SQL (Step 1)\n```sql\nselect * from enrollment_stage_type");
  });

  test("--story / --compact / --raw are mutually exclusive", async () => {
    const r = await show(await v2(SQL_UUID), ["--story", "--compact"]);
    expect(r.envelope?.ok).toBe(false);
  });
});

describe("ad show <file> (local body before save)", () => {
  test("a V2 file is parsed locally: nothing fetched, no edit URL", async () => {
    const path = `${FIX}/real-v2/${SQL_UUID}.v2.json`;
    expect(parseMethodFile(path).parsedSteps).toHaveLength(11);
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const fetch = spyOn(adApi, "fetchMethod");
    spies.push(fetch);
    const r = await runCommand(showCommand, [path, "--story"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).markdown).toContain("## configure.enrollment.stage.type.add.old");
    expect(fetch).not.toHaveBeenCalled();
    const lean = (await runCommand(showCommand, [path], { env: "t-dev" })).envelope?.data as any;
    expect(lean.source).toBe("file");
    expect(lean.summary.editUrl).toBeUndefined();
  });

  test("a non-method JSON file → INVALID_FILE", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const r = await runCommand(showCommand, [`${FIX}/categories/manifest.json`], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("INVALID_FILE");
  });
});

describe("show human step table: no HTML in cells", () => {
  test("rich-text descriptions become plain text, cut to 100 chars", () => {
    const rows = stepTableRows([
      { orderIndex: 2, kind: "EXISTING_SERVICE", description: 'If it returns false<ul><li>Return false with message "Operation not allowed"</li></ul>', identity: "Helpers.Legacy.exception.raise" },
      { orderIndex: 13, kind: "EXISTING_SERVICE", description: `Check &lt;epStageId&gt; ${"w".repeat(200)}` },
    ]);
    expect(rows[0]).toEqual([2, "[EXISTING]", 'If it returns false / Return false with message "Operation not allowed"', "Helpers.Legacy.exception.raise", ""]);
    expect(String(rows[1]![2]).startsWith("Check <epStageId> www")).toBe(true);
    expect(String(rows[1]![2])).toMatch(/…\(\+\d+\)$/);
  });
});

// rich-text step descriptions are shown as text; --full does not cut them.
describe("HTML step descriptions", () => {
  const RICH = "42eca7d0b957039f8538aa7480498546.v2.json";
  test("compact and story show the text, not the markup; --full keeps it whole", async () => {
    const m = parseV2Method(await Bun.file(`${FIX}/real-v2/${RICH}`).json(), { env: "acme-dev" });
    const step = m.parsedSteps[4]!;
    expect(step.description).toStartWith("<ul");
    const short = compactStepLine(step);
    expect(short).not.toMatch(/<ul|style=|&nbsp;/);
    const full = compactStepLine(step, { bodyChars: 0 });
    expect(full).not.toContain("…(+");
    expect(full.length).toBeGreaterThanOrEqual(short.length);
    expect(storyMarkdown(m)).not.toMatch(/<ul|<li|&nbsp;/);
  });
});

// the exit status code is part of the error contract.
describe("exit status codes", () => {
  test("V1 and V2 both render exit-on-fail and exit-if with the status code", async () => {
    const uuid = "4bfc83c74c3c3d2f60a5c7f6fa8bca3b";
    const files = readdirSync(`${FIX}/real-v2`).filter((f) => f.startsWith(uuid.slice(0, 8)));
    const m2 = parseV2Method(await Bun.file(`${FIX}/real-v2/${files[0]}`).json(), { env: "acme-dev" });
    const m1 = parseV1Method(await Bun.file(`${FIX}/real-v1/${files[0]!.replace(".v2.", ".v1.")}`).json());
    for (const m of [m1, m2]) {
      const line = compactMethod(m).steps.find((l) => l.includes("Email OR phone"))!;
      expect(line).toContain('exit-on-fail 400 "Email OR phone not provided"');
      expect(line).toContain('exit-if #{email} eq null and #{phone} eq null → 400 "Email OR phone not provided"');
    }
    const s = m2.parsedSteps.find((p) => p.forceExitStatusCode !== undefined)!;
    expect(String(s.forceExitStatusCode)).toBe("400");
    expect(storyMarkdown(m2)).toContain("stops the method on failure (400)");
  });
});

// the default view and step detail once dropped the conditional exit (send-gate).
describe("default show and step detail surface every gate", () => {
  test("Gates column, Exit If / Account detail, and methodDiffView see the conditional exit", async () => {
    const m = await v2(LOOP_UUID);
    const idx = m.parsedSteps.findIndex((s) => s.forceReturnExpression);
    expect(idx).toBeGreaterThanOrEqual(0);
    const step = m.parsedSteps[idx]!;

    const data = (await show(m, [])).envelope?.data as any;
    expect(data.steps[idx].gates.some((g: string) => g.startsWith("exit-if "))).toBe(true);

    const detail = (await show(m, ["--service-detail", String(step.orderIndex)])).envelope?.data as any;
    expect(detail.stepDetail.exitIf.expression).toBe(step.forceReturnExpression);
    expect(detail.stepDetail.config.some((c: any) => c.key === "Exit If")).toBe(true);

    const { methodDiffView, diffPaths } = await import("../../lib/fingerprint");
    const changed = structuredClone(await v2Raw(LOOP_UUID)) as any;
    changed.steps[idx].properties.exitCondition.conditionalExit.expression = "#{x} eq 1";
    const m2 = parseV2Method(changed, { env: "acme-dev" });
    expect(diffPaths(methodDiffView(m), methodDiffView(m2))).toEqual([`$.steps[${idx}].exitIf.expr`]);
  });
});
