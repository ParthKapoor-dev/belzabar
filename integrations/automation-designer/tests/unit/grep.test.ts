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
