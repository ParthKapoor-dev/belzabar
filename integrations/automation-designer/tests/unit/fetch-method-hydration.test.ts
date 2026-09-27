// adApi.fetchMethod classifies V1 steps through the definition lookup (AD-02):
// one GET /automations/{id} per distinct automationId, served from fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import { fakeFetch, fixture, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { adApi } from "../../lib/api/index";

const FIX = `${import.meta.dir}/../fixtures`;
const UUID = "41bb1b438875bd8b994196db1f12b7c2";
// Every automationId this method uses has a captured definition.
const ALL = Object.fromEntries(["976", "988", "998", "1000", "1038", "1039", "1040", "1041", "1042", "1043"].map((id) => [id, true]));

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = cfg = null;
});

function serve(env: string, defs: Record<string, boolean>) {
  cfg = withTempEnvConfig({ envs: { [env]: { url: `https://${env}.test` } }, activeEnv: env });
  ff = fakeFetch({
    "GET /rest/api/automation/chain/v2/*": fixture(`${FIX}/real-v2/${UUID}.v2.json`),
    "GET /rest/api/automation/chain/*": fixture(`${FIX}/real-v1/${UUID}.v1.json`),
    "GET /rest/api/automations/*": (req: { url: string }) => {
      const id = new URL(req.url).pathname.split("/").pop()!;
      return defs[id] ? respond({ file: `${FIX}/definitions/${id}.json` }) : respond({ status: 404, text: "" });
    },
  }).install();
}

describe("adApi.fetchMethod (V1) resolves step services", () => {
  test("every captured definition is fetched once; SQL steps are classified and decoded", async () => {
    serve("t-hyd1", ALL);
    const m = await adApi.fetchMethod(UUID, "v1");
    const defGets = ff!.requests.filter((r) => r.url.includes("/rest/api/automations/")).map((r) => r.url);
    expect(defGets.length).toBe(10);
    expect(new Set(defGets).size).toBe(10);
    const sql = m.parsedSteps.filter((s) => s.kind === "SQL");
    expect(sql.length).toBeGreaterThanOrEqual(3);
    expect(m.parsedSteps[0]!.serviceName).toBe("db_service");
    expect(m.parseWarnings.some((w) => w.includes("lookup failed"))).toBe(false);
  });

  test("a failed lookup leaves the step EXISTING_SERVICE and says so", async () => {
    serve("t-hyd2", {});
    const m = await adApi.fetchMethod(UUID, "v1");
    expect(m.parsedSteps.every((s) => s.kind !== "SQL")).toBe(true);
    expect(m.parseWarnings.some((w) => w.includes("lookup failed"))).toBe(true);
  });

  test("V2 needs no lookup: kinds agree with the resolved V1 parse", async () => {
    serve("t-hyd3", ALL);
    const m1 = await adApi.fetchMethod(UUID, "v1");
    const before = ff!.requests.length;
    const m2 = await adApi.fetchMethod(UUID, "v2");
    expect(ff!.requests.slice(before).every((r) => !r.url.includes("/automations/"))).toBe(true);
    expect(m2.parsedSteps.map((s) => s.kind)).toEqual(m1.parsedSteps.map((s) => s.kind));
  });
});
