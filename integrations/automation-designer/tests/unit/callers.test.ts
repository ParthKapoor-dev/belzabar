// `ad callers` — reverse index over AD steps (method index refs +
// V2 bodies for automationId-only steps) and PD httpRequests. Real acme-dev
// "Example services" fixtures through fakeFetch.
import { describe, expect, setSystemTime, test } from "bun:test";
import { existsSync } from "fs";
import { fakeFetch, fixture, respond, runCommand, withTempEnvConfig, type RecordedRequest } from "@belzabar/core/testing";
import callersCommand from "../../commands/callers/index";
import { findAdCallers, findPdCallers, resolveCallTarget, stepRefsOf, type CallTarget } from "../../lib/callers";
import { loadPdRefs, pdRefsOf } from "@belzabar/pd/lib/ad-refs";
import { loadOrBuildMethodFinderIndex, type MethodFinderIndex } from "../../lib/method-finder";

const FIX = `${import.meta.dir}/../fixtures`;
const PD_FIX = `${import.meta.dir}/../../../page-designer/tests/fixtures/real`;
const CAT = "4423ad307059bc3fc6859804c9bd12e0"; // "Example services"
const ARRAY_OUTPUT = "48e5d8bec3f5d7b5d689914d3b36aed8"; // called by "chaining method" (draft)
const CHAIN_FAILURE = "44103b20007389433f10ab8a923796f2"; // called by "chainParentMethod" (draft)
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };

function v2Route(req: RecordedRequest) {
  const uuid = req.url.match(/chain\/v2\/([0-9a-f]{32})/)?.[1];
  const file = `${FIX}/callers/v2/${uuid}.json`;
  return existsSync(file) ? new Response(Bun.file(file)) : new Response("", { status: 200 }); // AD: unknown uuid = 200 + empty body
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    "GET /rest/api/automation/services*": respond({
      json: { result: [{ id: 40, uuid: `${CAT}    `, name: "Example services", label: "Example services" }] },
    }),
    [`GET /rest/api/automation/methods?categoryUuid=${CAT}*`]: fixture(`${FIX}/callers/methods-example-services.json`),
    "GET /rest/api/automation/chain/v2/*": v2Route,
    "GET /rest/api/automation-systems/Example%20services/automation-apis/array%20output": fixture(`${FIX}/child-info/Example_services__array_output.json`),
    "GET /rest/api/automation-systems/*": respond({ text: "" }),
    ...extra,
  };
}

describe("callers target identity", () => {
  test("own + child-info API uuids, numeric id, chain uuids (published + draft ref)", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const t = await resolveCallTarget(ARRAY_OUTPUT);
    expect(t).toMatchObject({ name: "array output", category: "Example services", state: "PUBLISHED" });
    expect(t.apiUuids).toContain("45fe7e3d5d754cd67926a141c4faafe0");
    expect(t.apiIds).toEqual([2598]);
    expect(t.chainUuids).toContain(ARRAY_OUTPUT);
    expect(t.chainUuids).toContain("484973cc177a1166d039a314a1d1d217");
  });

  test("stepRefsOf keeps callee, description, set input keys and output names", async () => {
    const refs = stepRefsOf(await Bun.file(`${FIX}/callers/v2/40b270670686c47215d2b6ab839b276d.json`).json());
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ i: 1, api: "45fe7e3d5d754cd67926a141c4faafe0", service: "Example services", method: "array output" });
  });
});

describe("ad callers command", () => {
  test("finds the draft caller through its V2 body; reports coverage and unreadable bodies", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const r = await runCommand(callersCommand, [ARRAY_OUTPUT, "--refresh"], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(r.envelope?.ok).toBe(true);
    expect(d.callers).toEqual([
      { name: "chaining method", category: "Example services", state: "DRAFT", uuid: "40b270670686c47215d2b6ab839b276d", steps: [expect.stringMatching(/^1( |$)/)] },
    ]);
    expect(d.coverage.deepCategories).toEqual(["example services"]);
    expect(d.coverage.unscannedMethods).toBe(0);
    expect(d.coverage.resolvedMethods).toBe(9); // 12 listed − the target − 1 code-only (no call refs) − 1 unreadable
    expect(d.coverage.errors).toHaveLength(1); // "Expertly Header" body not in the fixtures
    expect(d.pd).toBeUndefined();
  });

  test("method bodies are cached per version: a second run reads none", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch(routes()).install();
    await runCommand(callersCommand, [CHAIN_FAILURE, "--refresh"], { env: "t-dev" });
    const reads = () => ff.requests.filter((q) => q.url.includes("/chain/v2/")).length;
    const first = reads();
    const r = await runCommand(callersCommand, [CHAIN_FAILURE], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.callers.map((c: any) => c.name)).toEqual(["chainParentMethod"]);
    // only the target (+ its published/draft counterpart) and the unreadable body are fetched again
    expect(reads() - first).toBeLessThanOrEqual(3);
  });

  test("--category must name indexed categories; --category and --all are exclusive", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const bad = await runCommand(callersCommand, [ARRAY_OUTPUT, "--category", "Nope"], { env: "t-dev" });
    expect(bad.envelope?.error?.code).toBe("CATEGORY_NOT_FOUND");
    const both = await runCommand(callersCommand, [ARRAY_OUTPUT, "--category", "x", "--all"], { env: "t-dev" });
    expect(both.envelope?.ok).toBe(false);
  });

  test("--pd scans pages + components (no match for this method)", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(
      routes({
        "GET /rest/api/pagedesigner/pages?status=DRAFT&pageType=PAGE&apiInfoLevel=MEDIUM": respond({
          json: [await Bun.file(`${PD_FIX}/4b2e06047e30dc8a57b08d163775345f.json`).json()],
        }),
        "GET /rest/api/pagedesigner/pages?status=PUBLISHED&pageType=PAGE&apiInfoLevel=MEDIUM": respond({ json: [] }),
        "GET /rest/api/pagedesigner/pages?*pageType=COMPONENT*": respond({ json: [await Bun.file(`${PD_FIX}/43488abaf65c8efc95ad880a346f38af.json`).json()] }),
      }),
    ).install();
    const d = (await runCommand(callersCommand, [ARRAY_OUTPUT, "--pd", "--refresh"], { env: "t-dev" })).envelope?.data as any;
    expect(d.pd).toEqual({ total: 0, callers: [], source: "fresh" });
  });
});

describe("index-resolved callers and scope", () => {
  const target: CallTarget = {
    uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "t", category: "Cat", state: "PUBLISHED",
    apiUuids: ["45fe7e3d5d754cd67926a141c4faafe0"], apiIds: [2598], chainUuids: [],
  };
  const method = (uuid: string, name: string, category: string, extra: object) =>
    ({ uuid, referenceId: "", aliasName: name, methodName: name, state: "PUBLISHED", version: 1, categoryUuid: "c", categoryName: category, createdOn: 0, updatedOn: 1, url: "", ...extra });

  test("u:/n: refs match env-wide without a deep scope; opaque methods elsewhere are counted", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch({ "GET /rest/api/automation/chain/v2/*": v2Route }).install();
    const index = {
      schemaVersion: 2, env: "t-dev", generatedAt: Date.now(), categories: [], skippedCategories: [], categoryCount: 2, methodCount: 3,
      methods: [
        // body available → the calling step is reported
        method("40b270670686c47215d2b6ab839b276d", "by-uuid", "Other", { calls: ["u:45fe7e3d5d754cd67926a141c4faafe0"] }),
        method("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "by-number", "Other", { calls: ["n:2598"] }),
        method("cccccccccccccccccccccccccccccccc", "opaque", "Far", { calls: [], opaqueSteps: 2 }),
      ],
    } as unknown as MethodFinderIndex;
    const res = await findAdCallers(index, target, { deep: new Set(["cat"]) });
    expect(res.callers.map((c) => c.name).sort()).toEqual(["by-number", "by-uuid"]);
    expect(res.callers.find((c) => c.name === "by-uuid")!.steps).toEqual([expect.stringMatching(/^1/)]);
    // body unreadable (not a fixture) but the index matched it
    expect(res.callers.find((c) => c.name === "by-number")!.steps).toEqual(["(matched by the index; body unreadable)"]);
    expect(res.coverage).toMatchObject({ unscannedMethods: 1, unscannedCategories: ["Far"] });
  });
});

describe("PD references", () => {
  test("pdRefsOf / findPdCallers match /chain/execute/<uuid> httpRequests", async () => {
    const page = await Bun.file(`${PD_FIX}/4b2e06047e30dc8a57b08d163775345f.json`).json();
    const refs = pdRefsOf(page, "PAGE")!;
    expect(refs.name).toBe("Student Information");
    expect(refs.calls.map((c) => c.adId)).toContain("400060c51c1e4d15aac995e452f7df55");
    const t = { chainUuids: ["400060c51c1e4d15aac995e452f7df55"] } as CallTarget;
    const found = findPdCallers([refs], t);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: "PAGE", name: "Student Information", id: "4b2e06047e30dc8a57b08d163775345f" });
    expect(found[0]!.calls[0]).toMatch(/\S/);
  });

  test("loadPdRefs caches the slim index (1 h)", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch({
      "GET /rest/api/pagedesigner/pages?status=DRAFT&pageType=PAGE&apiInfoLevel=MEDIUM": respond({ json: [await Bun.file(`${PD_FIX}/4b2e06047e30dc8a57b08d163775345f.json`).json()] }),
      "GET /rest/api/pagedesigner/pages?status=PUBLISHED&pageType=PAGE&apiInfoLevel=MEDIUM": respond({ json: [] }),
      "GET /rest/api/pagedesigner/pages?*pageType=COMPONENT*": respond({ json: [] }),
    }).install();
    const a = await loadPdRefs(true);
    expect(a.source).toBe("fresh");
    expect(a.items).toHaveLength(1);
    const n = ff.requests.length;
    const b = await loadPdRefs(false);
    expect(b.source).toBe("cache");
    expect(ff.requests.length).toBe(n);
  });

  // D25: the published page is what users run; it is listed with its own calls.
  test("published pages are listed beside the drafts, each with its own calls", async () => {
    const draft = await Bun.file(`${PD_FIX}/4b2e06047e30dc8a57b08d163775345f.json`).json();
    const published = { ...draft, id: "4f0000000000000000000000000000aa", status: "PUBLISHED" };
    using _cfg = withTempEnvConfig({ envs: { "t-pd25": { url: "https://t.test" } }, activeEnv: "t-pd25" });
    using _ff = fakeFetch({
      "GET /rest/api/pagedesigner/pages?status=DRAFT&pageType=PAGE&apiInfoLevel=MEDIUM": respond({ json: [draft] }),
      "GET /rest/api/pagedesigner/pages?status=PUBLISHED&pageType=PAGE&apiInfoLevel=MEDIUM": respond({ json: [published] }),
      "GET /rest/api/pagedesigner/pages?*pageType=COMPONENT*": respond({ json: [] }),
    }).install();
    const { items } = await loadPdRefs(true);
    const found = findPdCallers(items, { chainUuids: ["400060c51c1e4d15aac995e452f7df55"] } as CallTarget);
    expect(found.map((f) => `${f.status}:${f.id}`).sort()).toEqual(["DRAFT:4b2e06047e30dc8a57b08d163775345f", "PUBLISHED:4f0000000000000000000000000000aa"]);
  });

  // D26: a failed listing keeps the others, or the last complete index.
  test("a failed listing falls back to the last complete index (stale), else to the listings that worked", async () => {
    const page = await Bun.file(`${PD_FIX}/4b2e06047e30dc8a57b08d163775345f.json`).json();
    let up = true;
    using _cfg = withTempEnvConfig({ envs: { "t-pd26": { url: "https://t.test" } }, activeEnv: "t-pd26" });
    using _ff = fakeFetch({
      "GET /rest/api/pagedesigner/pages?status=DRAFT&pageType=PAGE&apiInfoLevel=MEDIUM": respond({ json: [page] }),
      "GET /rest/api/pagedesigner/pages?status=PUBLISHED&pageType=PAGE&apiInfoLevel=MEDIUM": respond({ json: [] }),
      "GET /rest/api/pagedesigner/pages?*pageType=COMPONENT*": () => (up ? new Response("[]") : new Response("", { status: 504 })),
    }).install();
    up = false;
    const partial = await loadPdRefs(true);
    expect(partial).toMatchObject({ source: "fresh", items: [expect.objectContaining({ id: page.id })], failed: [expect.objectContaining({ listing: "components" })] });
    expect((await loadPdRefs(false)).source).not.toBe("cache"); // a partial index is not saved
    up = true;
    await loadPdRefs(true);
    up = false;
    const stale = await loadPdRefs(true);
    expect(stale).toMatchObject({ source: "stale", ageMinutes: 0, items: [expect.objectContaining({ id: page.id })], failed: [expect.objectContaining({ listing: "components" })] });
  });

  test("the method index is shared with find (schema 2 cache reused)", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const a = await loadOrBuildMethodFinderIndex({ refresh: true });
    const b = await loadOrBuildMethodFinderIndex({ refresh: false, minSchema: 2 });
    expect(b.source).toBe("cache");
    expect(b.index.generatedAt).toBe(a.index.generatedAt);
  });
});

// the index goes stale when wi-impl writes a method, and a
// partial index (a category listing failed) must not claim full coverage.
describe("stale and partial method index", () => {
  const target: CallTarget = {
    uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "t", category: "Cat", state: "PUBLISHED",
    apiUuids: ["45fe7e3d5d754cd67926a141c4faafe0"], apiIds: [2598], chainUuids: [],
  };
  const CHAINING = "40b270670686c47215d2b6ab839b276d"; // its V2 body calls the target's API uuid
  const baseIndex = (methods: object[]) =>
    ({ schemaVersion: 2, env: "t-dev", generatedAt: Date.now(), categories: [], skippedCategories: [], categoryCount: 1, methodCount: methods.length, methods }) as unknown as MethodFinderIndex;
  const stale = { uuid: CHAINING, referenceId: "", aliasName: "chaining method", methodName: "chaining method", state: "DRAFT", version: 1, categoryUuid: "c", categoryName: "Far", createdOn: 0, updatedOn: 1, url: "", calls: [] };

  test("a method wi-impl changed since the build is re-read even outside the deep scope", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch({ "GET /rest/api/automation/chain/v2/*": v2Route }).install();
    const index = baseIndex([stale]);
    expect((await findAdCallers(index, target, { deep: new Set(["cat"]) })).callers).toEqual([]);
    const res = await findAdCallers(index, target, { deep: new Set(["cat"]), dirty: new Map([[CHAINING, Date.now()]]) });
    expect(res.callers.map((c) => c.name)).toEqual(["chaining method"]);
    expect(res.coverage.rereadMethods).toBe(1);
  });

  test("marked uuids the index lacks are read (created); deleted ones drop out silently", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch({ "GET /rest/api/automation/chain/v2/*": v2Route }).install();
    const gone = "dddddddddddddddddddddddddddddddd"; // 200 + empty body = METHOD_NOT_FOUND
    const res = await findAdCallers(baseIndex([]), target, { deep: new Set(["cat"]), dirty: new Map([[CHAINING, 1], [gone, 1]]) });
    expect(res.callers).toEqual([expect.objectContaining({ name: "chaining method", category: "Example services", state: "DRAFT", uuid: CHAINING })]);
    expect(res.coverage.errors).toBeUndefined();
  });

  test("CacheManager.invalidate (every wi-impl write) marks the index entry; a later build clears it", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const { CacheManager } = await import("../../lib/cache");
    const { loadDirtyMethods } = await import("../../lib/method-finder");
    const before = (await loadOrBuildMethodFinderIndex({ refresh: true })).index;
    await CacheManager.invalidate(CHAINING.toUpperCase(), "t-dev");
    expect([...(await loadDirtyMethods(before)).keys()]).toEqual([CHAINING]);
    await Bun.sleep(2);
    const after = (await loadOrBuildMethodFinderIndex({ refresh: true })).index;
    expect((await loadDirtyMethods(after)).size).toBe(0);
  });

  test("a partial index is marked, callers reports it and never claims completeness; it is rebuilt after 15 min", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch(routes({ [`GET /rest/api/automation/methods?categoryUuid=${CAT}*`]: respond({ status: 503, text: "" }) })).install();
    const r = await runCommand(callersCommand, [ARRAY_OUTPUT, "--refresh"], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(r.envelope?.ok).toBe(true);
    expect(d.coverage.skippedCategories).toEqual(["Example services"]);
    expect(d.coverage.complete).toBe(false);
    expect(((r.envelope?.meta?.warnings ?? []) as string[]).join("\n")).toMatch(/could not be listed/);
    const built = await loadOrBuildMethodFinderIndex({ refresh: false });
    expect(built).toMatchObject({ source: "cache", index: { partial: true } });
    setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
    try {
      const n = ff.requests.length;
      expect((await loadOrBuildMethodFinderIndex({ refresh: false })).source).toBe("fresh");
      expect(ff.requests.length).toBeGreaterThan(n);
    } finally {
      setSystemTime();
    }
  });

  test("a fresh complete scan is complete; a cached one says edits outside wi-impl are missed", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes({ "GET /rest/api/automation/chain/v2/*": v2Route })).install();
    const fresh = (await runCommand(callersCommand, [CHAIN_FAILURE, "--refresh"], { env: "t-dev" })).envelope;
    expect((fresh?.data as any).coverage).toMatchObject({ indexSource: "fresh" });
    const cached = (await runCommand(callersCommand, [CHAIN_FAILURE], { env: "t-dev" })).envelope;
    expect((cached?.data as any).coverage).toMatchObject({ indexSource: "cache", complete: false });
    expect(((cached?.meta?.warnings ?? []) as string[]).join("\n")).toMatch(/created or edited outside wi-impl/);
  });

  test("callers rebuilds an index older than 24 h (find keeps 7 days)", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    await loadOrBuildMethodFinderIndex({ refresh: true });
    setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
    try {
      expect((await loadOrBuildMethodFinderIndex({ refresh: false })).source).toBe("cache");
      expect((await loadOrBuildMethodFinderIndex({ refresh: false, maxAgeMs: 24 * 60 * 60 * 1000 })).source).toBe("fresh");
    } finally {
      setSystemTime();
    }
  });
});

// listing failures surface as stable codes, not UNHANDLED_EXCEPTION.
describe("listing failures have stable codes", () => {
  test("index build: category listing 503 → AD_INDEX_FETCH_FAILED", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes({ "GET /rest/api/automation/services*": respond({ status: 503, text: "" }) })).install();
    const r = await runCommand(callersCommand, [ARRAY_OUTPUT, "--refresh"], { env: "t-dev" });
    expect(r.envelope?.error).toMatchObject({ code: "AD_INDEX_FETCH_FAILED", details: { status: 503 } });
  });

  // D26: a PD failure never loses the AD callers.
  test("--pd: one page listing 503 → the AD callers and the other listings, failedListings and a warning", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-pd26a": { url: "https://t.test" } }, activeEnv: "t-pd26a" });
    using _ff = fakeFetch(
      routes({
        "GET /rest/api/pagedesigner/pages?status=DRAFT&pageType=PAGE&apiInfoLevel=MEDIUM": respond({ status: 503, text: "" }),
        "GET /rest/api/pagedesigner/pages?status=PUBLISHED&pageType=PAGE&apiInfoLevel=MEDIUM": respond({ json: [] }),
        "GET /rest/api/pagedesigner/pages?*pageType=COMPONENT*": respond({ json: [] }),
      }),
    ).install();
    const r = await runCommand(callersCommand, [ARRAY_OUTPUT, "--pd", "--refresh"], { env: "t-pd26a" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.callers.map((c: any) => c.name)).toEqual(["chaining method"]);
    expect(d.pd).toMatchObject({ source: "fresh", failedListings: [{ listing: "draft pages", code: "PD_LIST_FAILED" }] });
    expect(((r.envelope?.meta?.warnings ?? []) as string[]).join("\n")).toContain("PD listing failed: draft pages");
  });

  test("--pd: every listing fails and nothing is cached → pd.source unavailable with the error; AD callers kept", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-pd26b": { url: "https://t.test" } }, activeEnv: "t-pd26b" });
    using _ff = fakeFetch(routes({ "GET /rest/api/pagedesigner/pages*": respond({ status: 502, text: "" }) })).install();
    const r = await runCommand(callersCommand, [ARRAY_OUTPUT, "--pd", "--refresh"], { env: "t-pd26b" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.callers).toHaveLength(1);
    expect(d.pd).toMatchObject({ total: 0, callers: [], source: "unavailable", error: { code: "PD_LIST_FAILED" } });
    expect(((r.envelope?.meta?.warnings ?? []) as string[]).join("\n")).toContain("PD callers unavailable");
  });
});

// D16: a caller's draft and published copies are paired, and a differing draft is flagged.
describe("draft / published caller pairs", () => {
  const target: CallTarget = {
    uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "array output", category: "Example services", state: "PUBLISHED",
    apiUuids: ["45fe7e3d5d754cd67926a141c4faafe0"], apiIds: [], chainUuids: [],
  };
  const DRAFT = "dddddddddddddddddddddddddddddddd";
  const PUB = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const rec = (uuid: string, state: string, ref: string, updatedOn = 1) =>
    ({ uuid, referenceId: ref, aliasName: "c", methodName: "c", state, version: 1, categoryUuid: "c", categoryName: "Cat", createdOn: 0, updatedOn, url: "", calls: ["u:45fe7e3d5d754cd67926a141c4faafe0"] });
  const index = (methods: object[]) =>
    ({ schemaVersion: 2, env: "t-dev", generatedAt: Date.now(), categories: [], skippedCategories: [], categoryCount: 1, methodCount: methods.length, methods }) as unknown as MethodFinderIndex;

  async function serve(draftExtraStep: boolean) {
    const body = await Bun.file(`${FIX}/callers/v2/40b270670686c47215d2b6ab839b276d.json`).json();
    const draft = draftExtraStep ? { ...body, steps: [{ ...body.steps[0], automationAPIId: "f".repeat(32), serviceName: "Other", methodName: "x" }, ...body.steps] } : body;
    return fakeFetch({
      "GET /rest/api/automation/chain/v2/*": (req: RecordedRequest) => new Response(JSON.stringify(req.url.includes(DRAFT) ? draft : body)),
    }).install();
  }

  test("identical copies: both rows name the other, draftDiffers false", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = await serve(false);
    const res = await findAdCallers(index([rec(DRAFT, "DRAFT", PUB), rec(PUB, "PUBLISHED", DRAFT)]), target, { deep: null });
    expect(res.callers.map((c) => [c.state, c.counterpartUuid, c.draftDiffers, c.steps[0]!.split(" ")[0]])).toEqual([
      ["DRAFT", PUB, false, "1"],
      ["PUBLISHED", DRAFT, false, "1"],
    ]);
  });

  test("a draft with an added step: different step numbers, draftDiffers true; a non-calling copy is read to compare", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = await serve(true);
    const res = await findAdCallers(index([rec(DRAFT, "DRAFT", PUB, 2), rec(PUB, "PUBLISHED", DRAFT, 2)]), target, { deep: null });
    expect(res.callers.map((c) => [c.state, c.draftDiffers, c.steps[0]!.split(" ")[0]])).toEqual([
      ["DRAFT", true, "2"],
      ["PUBLISHED", true, "1"],
    ]);
    // only the draft is indexed as a caller: its published copy is still read and compared
    const one = await findAdCallers(index([rec(DRAFT, "DRAFT", PUB, 2), { ...rec(PUB, "PUBLISHED", DRAFT, 2), calls: [] }]), target, { deep: new Set(["none"]) });
    expect(one.callers.map((c) => [c.state, c.counterpartUuid, c.draftDiffers])).toEqual([["DRAFT", PUB, true]]);
  });
});

// review-verify: a 200 whose body is empty or not JSON (SSO / maintenance page)
// crashed `find` and `callers` with UNHANDLED_EXCEPTION (raw response.json()).
describe("find / callers on a non-JSON or empty 200 body", () => {
  const HTML = respond({ text: "<html><head><title>Maintenance</title></head></html>", headers: { "content-type": "text/html" } });
  test("the category listing: HTTP_BAD_JSON, not UNHANDLED_EXCEPTION", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes({ "GET /rest/api/automation/services*": HTML })).install();
    const findCommand = (await import("../../commands/find/index")).default;
    for (const [cmd, argv] of [[callersCommand, [ARRAY_OUTPUT, "--refresh"]], [findCommand, ["x", "--refresh"]]] as const) {
      const r = await runCommand(cmd as typeof callersCommand, [...argv], { env: "t-dev" });
      expect(r.envelope?.error?.code).toBe("HTTP_BAD_JSON");
      expect(r.envelope?.error?.message).toContain("Maintenance");
    }
  });

  test("a category's method page that is not JSON is a skipped category, an empty one has no methods", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    for (const body of [HTML, respond({ text: "" })]) {
      using _ff = fakeFetch(routes({ [`GET /rest/api/automation/methods?categoryUuid=${CAT}*`]: body })).install();
      const { index } = await loadOrBuildMethodFinderIndex({ refresh: true });
      expect(index.methods).toEqual([]);
    }
  });
});
