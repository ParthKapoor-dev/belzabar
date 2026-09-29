// One category identity (AD-09, AD-10, F9) over the real acme-dev listings.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import { buildCategories, findCategory, requireChainCategory } from "../../lib/categories";
import { normalizeCategoryRecord } from "../../lib/method-finder";
import { adApi } from "../../lib/api/index";
import categoriesCommand from "../../commands/categories/index";
import exportCategoryCommand from "../../commands/export-category/index";

const FIX = `${import.meta.dir}/../fixtures/categories`;
const chain = await Bun.file(`${FIX}/chain-category.json`).json();
const systems = await Bun.file(`${FIX}/chain-category-system.json`).json();
const services = await Bun.file(`${FIX}/automation-services.json`).json();

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});
function stubListings() {
  spies.push(
    spyOn(adApi, "listCategories").mockImplementation(async (o) => (o?.includeSystem ? systems : chain)),
    spyOn(process.stderr, "write").mockImplementation(() => true),
  );
}

describe("buildCategories", () => {
  const cats = buildCategories(chain, systems);

  test("Test-Tester: chain category 1135/4e98…, system 1318/4037…", () => {
    const tp = cats.find((c) => c.name === "Test-Tester")!;
    expect(tp).toMatchObject({
      chainCategoryId: 1135,
      chainCategoryUuid: "4e98700b2524e2accd47b4addf95ceca",
      systemId: 1318,
      systemUuid: "4037ada88a1a3ac30a1c9e63b6b0eed6",
      type: "USER_GENERATED",
    });
  });

  test("no uuid is padded; one row per category; system services have no chain category", () => {
    expect(cats.length).toBe(140);
    for (const c of cats) {
      for (const u of [c.chainCategoryUuid, c.systemUuid]) if (u) expect(u).toBe(u.trim());
    }
    const db = cats.find((c) => c.name === "db_service")!;
    expect(db).toMatchObject({ chainCategoryId: null, systemId: 6, type: "SYSTEM_GENERATED" });
    const userWithSystem = cats.filter((c) => c.type === "USER_GENERATED" && c.systemId !== null);
    expect(userWithSystem.length).toBeGreaterThanOrEqual(120);
  });

  test("ad find's index (from /automation/services) agrees on uuid and id (AD-10)", () => {
    for (const row of services.result) {
      const f = normalizeCategoryRecord(row)!;
      if (row.type !== "USER_GENERATED") continue;
      const c = cats.find((x) => x.chainCategoryUuid === f.uuid)!;
      expect(c).toBeDefined();
      expect(c.chainCategoryId).toBe(f.id);
    }
  });

  test("findCategory: id, system id, uuids (padded/upper), name", () => {
    for (const ref of ["1135", "1318", "4e98700b2524e2accd47b4addf95ceca", "4037ADA88A1A3AC30A1C9E63B6B0EED6    ", "test-tester"]) {
      expect(findCategory(cats, ref)?.chainCategoryId).toBe(1135);
    }
    expect(findCategory(cats, "nope")).toBeNull();
    expect(() => requireChainCategory(cats, "nope")).toThrow(expect.objectContaining({ code: "CATEGORY_NOT_FOUND" }));
    expect(() => requireChainCategory(cats, "db_service")).toThrow(expect.objectContaining({ code: "CATEGORY_NOT_CHAIN" }));
  });
});

describe("ad categories / export-category", () => {
  test("categories lists chainCategoryId as id, plus systemId (F9)", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    stubListings();
    const r = await runCommand(categoriesCommand, ["--user"], { env: "t-dev" });
    const tp = (r.envelope?.data as any).categories.find((c: any) => c.name === "Test-Tester");
    expect(tp).toMatchObject({ id: 1135, uuid: "4e98700b2524e2accd47b4addf95ceca", systemId: 1318 });
  });

  test("unfiltered listing warns toward --search; a search does not (CLI trial tr2)", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    stubListings();
    const all = await runCommand(categoriesCommand, [], { env: "t-dev" });
    expect((all.envelope?.data as any).total).toBe(140);
    expect(JSON.stringify(all.envelope?.meta.warnings)).toContain("--search");
    const one = await runCommand(categoriesCommand, ["--search", "test-tester"], { env: "t-dev" });
    expect((one.envelope?.data as any).total).toBe(1);
    expect(JSON.stringify(one.envelope?.meta.warnings ?? [])).not.toContain("--search");
  });

  test("export-category by name / system id exports chain category 1135", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    stubListings();
    const exp = spyOn(adApi, "exportCategory").mockResolvedValue({ chainDefinitions: [{}, {}] });
    spies.push(exp);
    for (const ref of ["Test-Tester", "1318"]) {
      const r = await runCommand(exportCategoryCommand, [ref], { env: "t-dev" });
      expect(r.envelope?.ok).toBe(true);
      expect((r.envelope?.data as any).id).toBe(1135);
      expect((r.envelope?.data as any).methodCount).toBe(2);
    }
    expect(exp.mock.calls.map((c) => c[0])).toEqual([1135, 1135]);
  });

  test("unknown category → CATEGORY_NOT_FOUND, nothing exported", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    stubListings();
    const exp = spyOn(adApi, "exportCategory").mockResolvedValue({});
    spies.push(exp);
    const r = await runCommand(exportCategoryCommand, ["No-Such-Cat"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("CATEGORY_NOT_FOUND");
    expect(exp).not.toHaveBeenCalled();
  });
});
