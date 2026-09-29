import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Cache, normalizeCacheKey } from "../src/cache";
import { Config } from "../src/config";
import { withTempEnvConfig } from "../src/testing";

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
    using _cfg = withTempEnvConfig({ envs: { "t-qa": { url: "https://q.test" }, "t-uat": { url: "https://u.test" } } });
    const prev = Config.activeEnv?.name;
    try {
      Config.setActiveEnv("t-qa");
      expect(c.dir).toBe(join(tmp, "active", "t-qa"));
      await c.save("k", { v: "qa" });
      Config.setActiveEnv("t-uat");
      expect(c.dir).toBe(join(tmp, "active", "t-uat"));
      expect(await c.load("k")).toBeNull();
      expect(await c.load("k", "t-qa")).toEqual({ v: "qa" });
    } finally {
      if (prev && Config.getAllEnvs()[prev]) Config.setActiveEnv(prev);
    }
  });

  test("legacy unscoped files are ignored (treated as a miss)", async () => {
    const c = makeCache("legacy");
    await Bun.write(join(tmp, "legacy", "old.json"), JSON.stringify({ savedAt: Date.now(), data: { v: "x" } }));
    expect(await c.load("old", "t-dev")).toBeNull();
  });

  test("envScoped:false keeps the flat layout", async () => {
    const c = makeCache("flat", { envScoped: false });
    await c.save("index-v1-t-dev", { v: "i" }, "whatever");
    expect(existsSync(join(tmp, "flat", "index-v1-t-dev.json"))).toBe(true);
    expect(await c.load("index-v1-t-dev")).toEqual({ v: "i" });
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

describe("core Cache — private files (CORE-R5)", () => {
  test("save creates 0700 dirs and 0600 entry files", async () => {
    const c = makeCache("private");
    await c.save("k1", { v: "x" }, "env-p");
    const { statSync } = await import("fs");
    expect(statSync(join(tmp, "private")).mode & 0o777).toBe(0o700);
    expect(statSync(join(tmp, "private", "env-p")).mode & 0o777).toBe(0o700);
    expect(statSync(join(tmp, "private", "env-p", "k1.json")).mode & 0o777).toBe(0o600);
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
