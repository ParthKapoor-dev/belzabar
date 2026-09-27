import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Cache, normalizeCacheKey } from "../src/cache";
import { Config } from "../src/config";

const tmp = mkdtempSync(join(tmpdir(), "belz-cache-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function makeCache(name: string, extra: Partial<ConstructorParameters<typeof Cache>[0]> = {}) {
  return new Cache<{ v: string }>({ dir: join(tmp, name), ttlMs: 60_000, ...extra });
}

describe("core Cache — env scoping (CORE-3)", () => {
  test("an entry saved for env A is a miss for env B", async () => {
    const c = makeCache("scoped");
    await c.save("abc", { v: "from-a" }, "env-a");
    expect(await c.load("abc", "env-a")).toEqual({ v: "from-a" });
    expect(await c.load("abc", "env-b")).toBeNull();
    expect(await c.loadSwr("abc", "env-b")).toBeNull();
    expect(existsSync(join(tmp, "scoped", "env-a", "abc.json"))).toBe(true);
  });

  test("defaults to Config.activeEnv and dir follows the active env", async () => {
    const c = makeCache("active");
    const prev = Config.activeEnv?.name;
    try {
      Config.setActiveEnv("nsm-qa");
      expect(c.dir).toBe(join(tmp, "active", "nsm-qa"));
      await c.save("k", { v: "qa" });
      Config.setActiveEnv("nsm-uat");
      expect(c.dir).toBe(join(tmp, "active", "nsm-uat"));
      expect(await c.load("k")).toBeNull();
      expect(await c.load("k", "nsm-qa")).toEqual({ v: "qa" });
    } finally {
      if (prev) Config.setActiveEnv(prev);
    }
  });

  test("legacy unscoped files are ignored (treated as a miss)", async () => {
    const c = makeCache("legacy");
    await Bun.write(join(tmp, "legacy", "old.json"), JSON.stringify({ savedAt: Date.now(), data: { v: "x" } }));
    expect(await c.load("old", "nsm-dev")).toBeNull();
  });

  test("envScoped:false keeps the flat layout", async () => {
    const c = makeCache("flat", { envScoped: false });
    await c.save("index-v1-nsm-dev", { v: "i" }, "whatever");
    expect(existsSync(join(tmp, "flat", "index-v1-nsm-dev.json"))).toBe(true);
    expect(await c.load("index-v1-nsm-dev")).toEqual({ v: "i" });
  });

  test("invalidate drops the entry for that env only", async () => {
    const c = makeCache("inv");
    await c.save("m", { v: "a" }, "env-a");
    await c.save("m", { v: "b" }, "env-b");
    await c.invalidate("m", "env-a");
    expect(await c.load("m", "env-a")).toBeNull();
    expect(await c.load("m", "env-b")).toEqual({ v: "b" });
    await c.invalidate("never-existed", "env-a"); // no throw
  });
});

describe("core Cache — keys", () => {
  test("numeric keys work with a TTL function (F5: key.includes is not a function)", async () => {
    const seen: unknown[] = [];
    const c = new Cache<{ v: string }>({
      dir: join(tmp, "numeric"),
      ttlMs: (key) => {
        seen.push(key);
        return key.includes("-") ? null : 60_000;
      },
    });
    await c.save(590 as unknown as string, { v: "def" }, "e");
    expect(await c.load(590 as unknown as string, "e")).toEqual({ v: "def" });
    expect(seen).toEqual(["590"]);
  });

  test("padded keys are trimmed; path separators neutralised", async () => {
    expect(normalizeCacheKey("  4bf5  ")).toBe("4bf5");
    expect(normalizeCacheKey("../x/y")).toBe(".._x_y");
    const c = makeCache("pad");
    await c.save("abc    ", { v: "p" }, "e");
    expect(readdirSync(join(tmp, "pad", "e"))).toEqual(["abc.json"]);
    expect(await c.load(" abc", "e")).toEqual({ v: "p" });
  });
});
