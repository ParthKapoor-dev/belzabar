// `ad find` read-view fixes: per-row freshness (D8), `--exact` (D9),
// `--category` method rows with chosen fields and no cap (D10), "no API id
// until first publish" (D28) and `type` kept under --fields (D37).
// Real "Example services" listing fixture.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fakeFetch, fixture, respond, runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import { markMethodIndexDirty } from "@belzabar/core/platform";
import findCommand, { exactRows } from "../../commands/find/index";
import type { MethodFinderMethod } from "../../lib/method-finder";

const FIX = `${import.meta.dir}/../fixtures`;
const CAT = "4423ad307059bc3fc6859804c9bd12e0"; // "Example services"
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };
const LISTING = JSON.parse(readFileSync(`${FIX}/callers/methods-example-services.json`, "utf8"));
const BLANK = LISTING.methodList[0]; // "Blank method", PUBLISHED v1, referenceId → its draft

function routes(extra: Record<string, unknown> = {}) {
  return {
    "GET /rest/api/automation/services*": respond({ json: { result: [{ id: 40, uuid: CAT, name: "Example services", label: "Example services" }] } }),
    [`GET /rest/api/automation/methods?categoryUuid=${CAT}*`]: fixture(`${FIX}/callers/methods-example-services.json`),
    ...extra,
  };
}

const method = (over: Partial<MethodFinderMethod>): MethodFinderMethod => ({
  uuid: "u",
  referenceId: "",
  aliasName: "m",
  methodName: "m",
  state: "DRAFT",
  version: 1,
  categoryUuid: "c",
  categoryName: "Cat",
  createdOn: 0,
  updatedOn: 0,
  url: "",
  ...over,
});

describe("D10: --category lists every method with chosen fields", () => {
  test("method fields are accepted; no cap unless --limit", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    await runCommand(findCommand, ["--refresh"], { env: "t-dev" });
    const r = await runCommand(findCommand, ["--category", "Example", "--fields", "uuid,name,state,version"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.methods).toHaveLength(d.totalMethods);
    expect(d.totalMethods).toBeGreaterThan(5);
    expect(Object.keys(d.methods[0]).sort()).toEqual(["name", "state", "uuid", "version", "versionAgeMinutes"]);
    const capped = await runCommand(findCommand, ["--category", "Example", "--limit", "3"], { env: "t-dev" });
    expect((capped.envelope?.data as any).methods).toHaveLength(3);
    expect((await runCommand(findCommand, ["--category", "Example", "--limit", "5000"], { env: "t-dev" })).envelope?.ok).toBe(true);
    // without --category the browse rows are categories: method fields stay unknown
    expect((await runCommand(findCommand, ["--fields", "state"], { env: "t-dev" })).envelope?.error?.code).toBe("INVALID_VALUE");
  });
});

describe("D37: --fields keeps `type`", () => {
  test("search rows always say what they are", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const r = await runCommand(findCommand, ["Blank method", "--fields", "name,category,uuid", "--refresh"], { env: "t-dev" });
    const rows = (r.envelope?.data as any).matches;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(["method", "category"]).toContain(row.type);
    expect(rows[0]).toMatchObject({ type: "method", name: "Blank method", category: "Example services" });
  });
});

describe("D9: --exact name → draft and published uuid", () => {
  test("several names, one row per method; unknown names are found:false", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const r = await runCommand(findCommand, ["--exact", "Blank method", "nope.missing", "--refresh"], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.mode).toBe("exact");
    expect(d.results[0]).toMatchObject({ name: "Blank method", found: true });
    expect(d.results[0].methods).toEqual([
      {
        name: "Blank method",
        category: "Example services",
        draftUuid: BLANK.referenceId,
        publishedUuid: BLANK.uuid,
        apiUuid: BLANK.automationApiUuid,
        publishedVersion: 1,
        versionAgeMinutes: 0,
      },
    ]);
    expect(d.results[1]).toEqual({ name: "nope.missing", found: false, methods: [] });
    expect(JSON.stringify(r.envelope?.meta)).toContain("No method named exactly nope.missing");
  });
  test("pairs a draft and its published row; exact, not fuzzy", () => {
    const rows = exactRows(
      [
        method({ uuid: "d1", referenceId: "p1", state: "DRAFT", version: 4, automationApiUuid: "api-d" }),
        method({ uuid: "p1", referenceId: "d1", state: "PUBLISHED", version: 3, automationApiUuid: "api-p" }),
        method({ uuid: "x", methodName: "m.other", aliasName: "m.other" }),
      ],
      "m",
    );
    expect(rows).toEqual([{ name: "m", category: "Cat", draftUuid: "d1", publishedUuid: "p1", apiUuid: "api-p", draftVersion: 4, publishedVersion: 3 }]);
  });
});

describe("D28: a never-published method says why it has no API id", () => {
  test("--exact and search rows carry apiUuidNote", async () => {
    expect(exactRows([method({ uuid: "d2" })], "m")[0]).toMatchObject({ draftUuid: "d2", apiUuidNote: "never published: no API id callers can use until first publish" });
    const listing = { ...LISTING, methodList: LISTING.methodList.map((m: any, i: number) => (i === 2 ? { ...m, automationApiUuid: null } : m)) };
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes({ [`GET /rest/api/automation/methods?categoryUuid=${CAT}*`]: listing })).install();
    const r = await runCommand(findCommand, ["chaining method", "--refresh"], { env: "t-dev" });
    const row = (r.envelope?.data as any).matches.find((m: any) => m.name === "chaining method");
    expect(row.apiUuid).toBeUndefined();
    const it = await runCommand(findCommand, ["Iteration"], { env: "t-dev" });
    const draftOnly = (it.envelope?.data as any).matches.find((m: any) => m.name === "Iteration");
    expect(draftOnly).toMatchObject({ state: "DRAFT", apiUuid: "41855dd8b27522ebc46d82fbce3e5edd", apiUuidNote: "never published: no API id callers can use until first publish" });
    expect(row.apiUuidNote).toBe("never published: no API id callers can use until first publish");
  });
});

describe("D8: rows of methods wi-impl wrote are re-read", () => {
  test("a method published after the index was built shows its new version (age 0)", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch(routes({ [`GET /rest/api/automation/chain/${BLANK.uuid}`]: { ...BLANK, version: 2 } })).install();
    await runCommand(findCommand, ["--refresh"], { env: "t-dev" });
    await new Promise((r) => setTimeout(r, 5));
    const before = await runCommand(findCommand, ["Blank method", "--fields", "name,version"], { env: "t-dev" });
    expect((before.envelope?.data as any).matches[0]).toMatchObject({ version: 1, versionAgeMinutes: 0 });
    await markMethodIndexDirty("t-dev", BLANK.uuid); // what ad publish / save do
    const r = await runCommand(findCommand, ["Blank method", "--fields", "name,version"], { env: "t-dev" });
    expect((r.envelope?.data as any).matches[0]).toMatchObject({ type: "method", name: "Blank method", version: 2, versionAgeMinutes: 0 });
    expect(ff.requests.some((q) => q.url.includes(`/automation/chain/${BLANK.uuid}`))).toBe(true);
  });
});
