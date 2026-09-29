// CLI trial: `ad find --category X` returned only a count, `--raw` ignored
// --category, `ad categories` had no filter, and a deleted method stayed in
// the cached index until `--refresh`. Real "Example services" listing fixture.
import { describe, expect, test } from "bun:test";
import { fakeFetch, fixture, respond, runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import findCommand from "../../commands/find/index";
import categoriesCommand from "../../commands/categories/index";
import * as v2 from "../../lib/api/v2";
import { addMethodToIndex } from "../../lib/method-finder";

const FIX = `${import.meta.dir}/../fixtures`;
const CAT = "4423ad307059bc3fc6859804c9bd12e0"; // "Example services"
const OTHER = "4c1eb487ee7f4be7c4bfb246809bce25";
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };
const GONE = "48e5d8bec3f5d7b5d689914d3b36aed8";

function routes() {
  return {
    "GET /rest/api/automation/services*": respond({
      json: {
        result: [
          { id: 40, uuid: `${CAT}    `, name: "Example services", label: "Example services" },
          { id: 15, uuid: OTHER, name: "Schools" },
        ],
      },
    }),
    [`GET /rest/api/automation/methods?categoryUuid=${CAT}*`]: fixture(`${FIX}/callers/methods-example-services.json`),
    [`GET /rest/api/automation/methods?categoryUuid=${OTHER}*`]: respond({ json: { methodList: [] } }),
    // a deleted method: V2 answers 200 + empty body
    [`GET /rest/api/automation/chain/v2/${GONE}*`]: respond({ text: "" }),
  };
}

describe("ad find --category", () => {
  test("without a query lists the category's methods (name prefix, id or uuid)", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    await runCommand(findCommand, ["--refresh"], { env: "t-dev" });
    for (const ref of ["example", "40", CAT]) {
      const r = await runCommand(findCommand, ["--category", ref, "--limit", "5"], { env: "t-dev" });
      const d = r.envelope?.data as any;
      expect(d.categories.map((c: any) => c.name)).toEqual(["Example services"]);
      expect(d.totalMethods).toBe(12);
      expect(d.methods).toHaveLength(5);
      expect(d.methods[0]).toMatchObject({ category: "Example services" });
      expect(d.methods[0].uuid).toMatch(/^[0-9a-f]{32}$/);
    }
    // no --category: counts only, as before
    expect((await runCommand(findCommand, [], { env: "t-dev" })).envelope?.data).not.toHaveProperty("methods");
  });

  test("--raw is scoped by --category", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    const r = await runCommand(findCommand, ["--category", "Schools", "--raw", "--refresh"], { env: "t-dev" });
    const raw = (r.envelope?.data as any).raw;
    expect(raw.index.categories.map((c: any) => c.name)).toEqual(["Schools"]);
    expect(raw.index.methods).toEqual([]);
    const q = await runCommand(findCommand, ["a", "--category", "Schools", "--raw"], { env: "t-dev" });
    expect((q.envelope?.data as any).raw.index.methods).toEqual([]);
  });

  test("a method whose V2 read is METHOD_NOT_FOUND leaves the cached index at once", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    await runCommand(findCommand, ["--refresh"], { env: "t-dev" });
    const before = await runCommand(findCommand, ["--category", "40", "--limit", "50"], { env: "t-dev" });
    expect((before.envelope?.data as any).methods.map((m: any) => m.uuid)).toContain(GONE);
    await expect(v2.fetchRawMethod(GONE)).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    const after = await runCommand(findCommand, ["--category", "40", "--limit", "50"], { env: "t-dev" });
    const d = after.envelope?.data as any;
    expect(d.cache.source).toBe("cache");
    expect(d.methods.map((m: any) => m.uuid)).not.toContain(GONE);
    expect(d.totalMethods).toBe(11);
    expect(d.categories[0].methods).toBe(11);
  });
});

describe("a method belz created is in the cached index at once", () => {
  test("addMethodToIndex (called by ad create) → find --category lists it", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes()).install();
    await runCommand(findCommand, ["--refresh"], { env: "t-dev" });
    const NEW = "4fffffffffffffffffffffffffffffff";
    await addMethodToIndex("t-dev", { uuid: NEW, name: "belz_tst_new", categoryUuid: OTHER, categoryName: "Schools", summary: "s" });
    await addMethodToIndex("t-dev", { uuid: NEW, name: "belz_tst_new", categoryUuid: OTHER, categoryName: "Schools" }); // idempotent
    const d = (await runCommand(findCommand, ["--category", "Schools"], { env: "t-dev" })).envelope?.data as any;
    expect(d.cache.source).toBe("cache");
    expect(d.methods).toEqual([expect.objectContaining({ name: "belz_tst_new", uuid: NEW, state: "DRAFT" })]);
    expect(d.categories[0].methods).toBe(1);
  });
});

describe("ad categories --search", () => {
  test("filters by name/label substring, id or uuid", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch({
      "GET /rest/api/automation/chain/category?fetchSystemServices=false": fixture(`${FIX}/categories/chain-category.json`),
      "GET /rest/api/automation/chain/category?fetchSystemServices=true": fixture(`${FIX}/categories/chain-category-system.json`),
    }).install();
    const r = await runCommand(categoriesCommand, ["--search", "TEST-TESTER"], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.categories.map((c: any) => c.name)).toEqual(["Test-Tester"]);
    expect(d.total).toBe(1);
    const byId = await runCommand(categoriesCommand, ["--search", "1135"], { env: "t-dev" });
    expect((byId.envelope?.data as any).categories.map((c: any) => c.id)).toEqual([1135]);
  });
});
