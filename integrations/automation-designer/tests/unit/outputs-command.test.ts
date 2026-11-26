// `ad outputs` (V1, contract only) said `variables: []` while
// `show --compact` (V2) showed `-> flatData[]→json, rowsImpacted→rc`; it was
// unclear whether json/rc exist. Both now read V2 fresh, and outputs lists
// what every step writes and whether the method declares it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { fakeFetch, runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import outputsCommand from "../../commands/outputs/index";

const REAL = `${import.meta.dir}/../fixtures/real-v2`;
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };

// A real body with at least one step output the method does not declare.
function pick(): { uuid: string; body: any } {
  for (const f of readdirSync(REAL).filter((x) => x.endsWith(".v2.json"))) {
    const body = JSON.parse(readFileSync(`${REAL}/${f}`, "utf8"));
    const declared = new Set([...(body.outputs ?? []), ...(body.variables ?? []), ...(body.inputs ?? [])].map((o: any) => o.key));
    const undeclared = (body.steps ?? []).some((s: any) => (s.outputs ?? []).some((o: any) => o.fieldCode && !declared.has(o.fieldCode)));
    const some = (body.steps ?? []).some((s: any) => (s.outputs ?? []).some((o: any) => declared.has(o.fieldCode)));
    if (undeclared && some) return { uuid: f.slice(0, 32), body };
  }
  throw new Error("no fixture with undeclared + declared step outputs");
}

describe("ad outputs stepOutputs", () => {
  test("lists every step output with its declaration, from the V2 read", async () => {
    const { uuid, body } = pick();
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch({ [`GET /rest/api/automation/chain/v2/${uuid}*`]: body }).install();
    const r = await runCommand(outputsCommand, [uuid], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.sourceVersion).toBe("v2");
    // the V2 read, plus the V1 read that looks for loops only V1 holds (K1)
    expect(ff.requests.every((q) => q.url.includes("/chain/v2/") || q.url.includes(`/chain/${uuid}`))).toBe(true);
    const total = (body.steps as any[]).reduce((n, s) => n + (s.outputs ?? []).length, 0);
    expect(d.stepOutputs).toHaveLength(total);
    const undeclared = d.stepOutputs.filter((x: any) => x.declaredAs === null);
    expect(undeclared.length).toBeGreaterThan(0);
    expect(d.stepOutputs.some((x: any) => x.declaredAs !== null)).toBe(true);
    expect(d.notes[0]).toContain(undeclared[0].as);
    const first = body.steps.findIndex((s: any) => (s.outputs ?? []).length > 0);
    expect(d.stepOutputs[0]).toMatchObject({ step: first + 1, key: body.steps[first].outputs[0].key, as: body.steps[first].outputs[0].fieldCode });
  });

  test("D27: input and variable defaults are listed (whole), test values apart", async () => {
    const { uuid, body } = pick();
    const sql = "insdata AS (INSERT INTO t SELECT 1)";
    const withDefaults = {
      ...body,
      inputs: [...(body.inputs ?? []), { key: "batching", name: "batching", type: "JSON", defaultValue: '{"size":200}' }],
      variables: [...(body.variables ?? []), { key: "filterClauseFinal", name: "filterClauseFinal", type: "TEXT", defaultValue: sql }],
    };
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch({ [`GET /rest/api/automation/chain/v2/${uuid}*`]: withDefaults }).install();
    const d = (await runCommand(outputsCommand, [uuid], { env: "t-dev" })).envelope?.data as any;
    expect(d.inputs.at(-1)).toEqual({ code: "batching", type: "JSON", required: false, description: "", defaultValue: '{"size":200}' });
    expect(d.variables.at(-1)).toMatchObject({ code: "filterClauseFinal", defaultValue: sql });
    expect(d.inputs.slice(0, -1).every((i: any) => !("defaultValue" in i) || i.defaultValue !== undefined)).toBe(true);
  });
});
