// `ad grep`: regex over step texts (SQL and code decoded from base64, SpEL, input values),
// scoped by category (method index + per-version cached bodies) or by uuid. Real sanitized
// "Example services" callers fixtures and a real V2 body with base64 SQL, through fakeFetch.
import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { fakeFetch, fixture, respond, runCommand, withTempEnvConfig, type RecordedRequest } from "@belzabar/core/testing";
import grepCommand from "../../commands/grep/index";
import { stepTextsOf } from "../../lib/grep";

const FIX = `${import.meta.dir}/../fixtures`;
const CAT = "4423ad307059bc3fc6859804c9bd12e0"; // "Example services"
const SQL_METHOD = "4ada8d56841853491129898f5069679e"; // real V2 body, base64 SQL steps 1 and 5
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };

function v2Route(req: RecordedRequest) {
  const uuid = req.url.match(/chain\/v2\/([0-9a-f]{32})/)?.[1];
  const file = uuid === SQL_METHOD ? `${FIX}/real-v2/${uuid}.v2.json` : `${FIX}/callers/v2/${uuid}.json`;
  return existsSync(file) ? new Response(Bun.file(file)) : new Response("", { status: 200 }); // AD: unknown uuid = 200 + empty body
}

const routes = {
  "GET /rest/api/automation/services*": respond({
    json: { result: [{ id: 40, uuid: `${CAT}    `, name: "Example services", label: "Example services" }] },
  }),
  [`GET /rest/api/automation/methods?categoryUuid=${CAT}*`]: fixture(`${FIX}/callers/methods-example-services.json`),
  "GET /rest/api/automation/chain/v2/*": v2Route,
};
const bodyReads = (ff: { requests: RecordedRequest[] }) => ff.requests.filter((q) => q.url.includes("/chain/v2/")).length;

describe("stepTextsOf", () => {
  test("decodes base64 SQL; conditions and input values are spel; the SQL slot is not repeated as an input", async () => {
    const texts = stepTextsOf(await Bun.file(`${FIX}/real-v2/${SQL_METHOD}.v2.json`).json());
    const sql = texts.filter((t) => t.kind === "sql");
    expect(sql.map((t) => t.step)).toEqual([1, 5]);
    expect(sql[0]!.text).toStartWith("WITH latest_run AS (SELECT");
    expect(texts.some((t) => t.field === "input body.queryString")).toBe(false);
    expect(texts.find((t) => t.step === 2 && t.field === "condition")?.text).toContain(" eq 'true'");
  });
});

describe("ad grep command", () => {
  test("--method: SQL matches with step, field and line; --in narrows; -i ignores case", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes).install();
    const r = await runCommand(grepCommand, ["row_number\\(\\)", "--method", SQL_METHOD, "-i", "--in", "sql"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.total).toBeGreaterThan(0);
    expect(d.matches[0]).toMatchObject({ uuid: SQL_METHOD, step: 1, kind: "sql", field: "sql", line: 1 });
    expect(d.coverage).toMatchObject({ scope: "methods", scanned: 1, unscanned: 0 });
    const spelOnly = await runCommand(grepCommand, ["ROW_NUMBER", "--method", SQL_METHOD, "--in", "spel"], { env: "t-dev" });
    expect((spelOnly.envelope?.data as any).total).toBe(0);
    const cased = await runCommand(grepCommand, ["row_number\\(\\)", "--method", SQL_METHOD, "--in", "sql"], { env: "t-dev" });
    expect((cased.envelope?.data as any).total).toBe(0);
  });

  test("--category: custom code matched per line across the category; bodies are cached per version", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch(routes).install();
    const r = await runCommand(grepCommand, ["console\\.log", "--category", "Example services", "--in", "code", "--refresh"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    const hits = d.matches.map((m: any) => `${m.method}#${m.step}:${m.line}`);
    expect(hits).toContain("Iteration logic#3:2");
    expect(hits).toContain("testChainFailure#1:1");
    expect(d.matches.every((m: any) => m.kind === "code" && m.category === "Example services")).toBe(true);
    expect(d.coverage.scope).toEqual(["Example services"]);
    expect(d.coverage.errors).toHaveLength(1); // one body is not in the fixtures
    const first = bodyReads(ff);
    const again = await runCommand(grepCommand, ["console\\.log", "--category", "Example services"], { env: "t-dev" });
    expect((again.envelope?.data as any).total).toBe(d.total);
    expect(bodyReads(ff)).toBe(first); // cached (and the failure remembered)
  });

  test("--draft keeps drafts only", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes).install();
    const r = await runCommand(grepCommand, [".", "--category", "Example services", "--draft", "--refresh"], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.total).toBeGreaterThan(0);
    expect(d.matches.every((m: any) => m.state === "DRAFT")).toBe(true);
  });

  test("argument errors fail before any request", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch(routes).install();
    const code = async (argv: string[]) => (await runCommand(grepCommand, argv, { env: "t-dev" })).envelope?.error?.code;
    expect(await code(["(", "--all"])).toBe("INVALID_PATTERN");
    expect(await code(["x"])).toBe("MISSING_FLAG");
    expect(await code(["x", "--all", "--category", "A"])).toBe("CONFLICTING_FLAGS");
    expect(await code(["x", "--all", "--in", "sql,nope"])).toBe("INVALID_VALUE");
    expect(ff.requests).toEqual([]);
    expect(await code(["x", "--category", "Nope"])).toBe("CATEGORY_NOT_FOUND");
  });
});

describe("what grep searches (D12, D13)", () => {
  const TC = "4252b87e4d77d2a6e8f59325550558ae"; // test-cases fixture: draft.v2.json + suite.json
  const tcRoutes = {
    [`GET /rest/api/automation/chain/v2/${TC}*`]: fixture(`${FIX}/test-cases/draft.v2.json`),
    [`GET /rest/api/automation/chain/testsuite/service-chain/${TC}`]: fixture(`${FIX}/test-cases/suite.json`),
  };

  test("a call step's target is searched as `call` (Category/method) by default", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes).install();
    const r = await runCommand(grepCommand, ["array output", "--method", "40b270670686c47215d2b6ab839b276d"], { env: "t-dev" });
    expect((r.envelope?.data as any).matches).toEqual([
      expect.objectContaining({ step: 1, kind: "call", field: "call", excerpt: "Example services/array output" }),
    ]);
    const sqlOnly = await runCommand(grepCommand, ["array output", "--method", "40b270670686c47215d2b6ab839b276d", "--in", "sql"], { env: "t-dev" });
    expect((sqlOnly.envelope?.data as any).total).toBe(0);
  });

  test("--include descriptions searches method and step descriptions; tests searches the test cases", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(tcRoutes).install();
    const plain = await runCommand(grepCommand, ["probe|Mars", "--method", TC], { env: "t-dev" });
    expect((plain.envelope?.data as any).total).toBe(0);
    const r = await runCommand(grepCommand, ["probe|Mars", "--method", TC, "--include", "descriptions,tests"], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.in).toEqual(["sql", "code", "spel", "call", "description", "test"]);
    const where = d.matches.map((m: any) => `${m.kind}:${m.step}:${m.field}`);
    expect(where).toContain("description:0:description");
    expect(where).toContain("test:0:test belz_tst_s7c_t1.greet.mars.2 input name");
    expect(where).toContain("test:0:test belz_tst_s7c_t1.greet.mars.2 description");
    expect((await runCommand(grepCommand, ["x", "--method", TC, "--include", "nope"], { env: "t-dev" })).envelope?.error?.code).toBe("INVALID_VALUE");
  });

  test("a leading (?i) is read as -i; another inline flag fails with a hint naming -i", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes).install();
    const r = await runCommand(grepCommand, ["(?i)ROW_NUMBER\\(\\)", "--method", SQL_METHOD, "--in", "sql"], { env: "t-dev" });
    expect((r.envelope?.data as any).total).toBeGreaterThan(0);
    const bad = await runCommand(grepCommand, ["(?s)x", "--all"], { env: "t-dev" });
    expect(bad.envelope?.error?.code).toBe("INVALID_PATTERN");
    expect(bad.envelope?.error?.message).toContain("use -i");
  });
});

describe("partial scope (D14) and unreadable V2 bodies (D15)", () => {
  test("an unknown --category is warned about with close names and the rest are searched", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes).install();
    const r = await runCommand(grepCommand, ["console\\.log", "--category", "Example services,Exampel service", "--in", "code", "--refresh"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.total).toBeGreaterThan(0);
    expect(d.coverage.unknownCategories).toEqual([{ name: "Exampel service", suggestions: ["Example services"] }]);
    expect(((r.envelope?.meta?.warnings ?? []) as string[]).join("\n")).toContain("Unknown categories not searched: Exampel service (did you mean: Example services?)");
    const none = await runCommand(grepCommand, ["x", "--category", "Exampel service"], { env: "t-dev" });
    expect(none.envelope?.error).toMatchObject({ code: "CATEGORY_NOT_FOUND", details: { suggestions: { "Exampel service": ["Example services"] } } });
  });

  test("a V2 400 falls back to the V1 parse, and the 400 is not cached as a failure", async () => {
    const V1 = "41bb1b438875bd8b994196db1f12b7c2"; // real-v1 body with every service definition captured
    let v1Up = false;
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch({
      "GET /rest/api/automation/chain/v2/*": respond({ status: 400, text: "" }),
      "GET /rest/api/automation/chain/*": () => (v1Up ? new Response(Bun.file(`${FIX}/real-v1/${V1}.v1.json`)) : new Response("", { status: 503 })),
      "GET /rest/api/automations/*": (req: RecordedRequest) => new Response(Bun.file(`${FIX}/definitions/${new URL(req.url).pathname.split("/").pop()}.json`)),
    }).install();
    const { readBodyCached } = await import("../../lib/callers");
    const { Cache } = await import("@belzabar/core");
    const { methodTextsOf } = await import("../../lib/grep");
    const cache = new Cache<unknown[]>({ dir: `${process.env.WI_IMPL_HOME}/cache/grep-fallback-test`, ttlMs: 60_000 });
    const m = { uuid: V1, methodName: "m", categoryName: "c", state: "DRAFT", updatedOn: 1 } as any;
    // V1 down too: the V2 400 is reported, and not remembered
    await expect(readBodyCached(m, `${V1}@1`, cache, stepTextsOf, false, methodTextsOf)).rejects.toMatchObject({ details: { status: 400 } });
    v1Up = true;
    const texts = (await readBodyCached(m, `${V1}@1`, cache, stepTextsOf, false, methodTextsOf)) as any[];
    expect(texts.some((t) => t.kind === "sql")).toBe(true);
    const r = await runCommand(grepCommand, ["select", "-i", "--method", V1, "--in", "sql"], { env: "t-dev" });
    expect((r.envelope?.data as any).coverage).toMatchObject({ scanned: 1, unscanned: 0 });
    expect((r.envelope?.data as any).total).toBeGreaterThan(0);
  });
});
