// platform/entity-cache.ts — evicting another env's AD method / PD page cache entries.
import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { Cache } from "../src/cache";
import { finderIndexStore } from "../src/finder-index";
import { invalidateEntityCache, METHOD_CACHE_DIR, METHOD_FINDER_INDEX, methodIndexDirtyKey, PAGE_CACHE_DIR } from "../src/platform";

const methods = new Cache<unknown>({ dir: METHOD_CACHE_DIR, ttlMs: null });
const pages = new Cache<unknown>({ dir: PAGE_CACHE_DIR, ttlMs: null });
const marks = new Cache<Record<string, number>>({ dir: finderIndexStore(METHOD_FINDER_INDEX).dir, ttlMs: null, envScoped: false });

describe("invalidateEntityCache", () => {
  test("AD: drops only the named env's entry (uuid case-folded) and marks it dirty in the method index", async () => {
    const uuid = "abcdef0123456789abcdef0123456789";
    await methods.save(uuid, { v: 1 }, "t-qa");
    await methods.save(uuid, { v: 1 }, "t-dev");
    const done = await invalidateEntityCache("AD", "t-qa", [` ${uuid.toUpperCase()} `]);
    expect(done).toEqual([uuid]);
    expect(existsSync(join(METHOD_CACHE_DIR, "t-qa", `${uuid}.json`))).toBe(false);
    expect(await methods.load(uuid, "t-dev")).toEqual({ v: 1 });
    expect(Object.keys((await marks.load(methodIndexDirtyKey("t-qa"))) ?? {})).toContain(uuid);
  });

  test("PD: drops the page entry; a missing entry is not an error", async () => {
    await pages.save("p1", { id: "p1" }, "t-qa");
    expect(await invalidateEntityCache("PD", "t-qa", ["p1", "p1", "missing", ""])).toEqual(["p1", "missing"]);
    expect(await pages.load("p1", "t-qa")).toBeNull();
  });
});
