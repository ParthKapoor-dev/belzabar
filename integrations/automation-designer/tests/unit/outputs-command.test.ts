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
    expect(ff.requests.every((q) => q.url.includes("/chain/v2/"))).toBe(true);
    const total = (body.steps as any[]).reduce((n, s) => n + (s.outputs ?? []).length, 0);
    expect(d.stepOutputs).toHaveLength(total);
    const undeclared = d.stepOutputs.filter((x: any) => x.declaredAs === null);
    expect(undeclared.length).toBeGreaterThan(0);
    expect(d.stepOutputs.some((x: any) => x.declaredAs !== null)).toBe(true);
    expect(d.notes[0]).toContain(undeclared[0].as);
    const first = body.steps.findIndex((s: any) => (s.outputs ?? []).length > 0);
    expect(d.stepOutputs[0]).toMatchObject({ step: first + 1, key: body.steps[first].outputs[0].key, as: body.steps[first].outputs[0].fieldCode });
  });
});
