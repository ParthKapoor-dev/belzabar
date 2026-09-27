// Regression tests for env-scoped AD caches (AD-04, AD-05, AD-06, AD-24, F4, F5).
// BELZ_HOME is set to a tmp dir by the bunfig.toml test preload before
// @belzabar/core is first imported; beforeAll asserts it so nothing can ever
// touch the real ~/.belz.
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmp = process.env.BELZ_HOME ?? mkdtempSync(join(tmpdir(), "belz-ad-cache-test-"));
process.env.BELZ_HOME = tmp;

// Fake network layer: no HTTP ever leaves the test.
const calls: string[] = [];
mock.module("../../lib/api/v1", () => ({
  publishDraft: async (draft: string) => {
    calls.push(`publish:${draft}`);
    return { publishedUuid: "PUB1" };
  },
  fetchAutomationDefinition: async (id: string) => {
    calls.push(`def:${id}`);
    return { automationAPI: { id } };
  },
  historyUuidCacheKey: (env: string | undefined, name: string) => `${env ?? "default"}:${name}`,
}));

let core: typeof import("@belzabar/core");
let CacheManager: typeof import("../../lib/cache").CacheManager;
let ServiceHydrator: typeof import("../../lib/hydrator").ServiceHydrator;
let adApi: typeof import("../../lib/api/index").adApi;

beforeAll(async () => {
  core = await import("@belzabar/core");
  ({ CacheManager } = await import("../../lib/cache"));
  ({ ServiceHydrator } = await import("../../lib/hydrator"));
  ({ adApi } = await import("../../lib/api/index"));
  // Guard: never write outside the tmp root.
  if (core.BELZ_CONFIG_DIR !== tmp || !tmp.startsWith(tmpdir())) {
    throw new Error(`refusing to run: BELZ_CONFIG_DIR=${core.BELZ_CONFIG_DIR} is not the test tmp dir`);
  }
});
afterAll(() => rmSync(join(tmp, "cache"), { recursive: true, force: true }));

const fakeMethod = (tag: string) => ({ uuid: tag, sourceVersion: "v1" }) as any;

describe("AD method cache", () => {
  test("is env-scoped (AD-04 / F4)", async () => {
    await CacheManager.save("aaaa", fakeMethod("dev-body"), "nsm-dev");
    expect((await CacheManager.load("aaaa", "nsm-dev"))?.uuid).toBe("dev-body");
    expect(await CacheManager.load("aaaa", "nsm-qa")).toBeNull();
    expect(existsSync(join(tmp, "cache", "methods", "nsm-dev", "aaaa.json"))).toBe(true);
  });

  test("padded / upper-case uuids map to one trimmed lower-case file", async () => {
    await CacheManager.save("  4BF5E00    ", fakeMethod("p"), "e1");
    expect(readdirSync(join(tmp, "cache", "methods", "e1"))).toEqual(["4bf5e00.json"]);
    expect((await CacheManager.loadSwr("4bf5e00", "e1"))?.data.uuid).toBe("p");
  });

  test("dir follows the active env", () => {
    core.Config.setActiveEnv("nsm-qa");
    expect(CacheManager.dir).toBe(join(tmp, "cache", "methods", "nsm-qa"));
    core.Config.setActiveEnv("nsm-dev");
    expect(CacheManager.dir).toBe(join(tmp, "cache", "methods", "nsm-dev"));
  });

  test("adApi.publishDraft invalidates touched uuids (AD-06)", async () => {
    core.Config.setActiveEnv("nsm-dev");
    for (const id of ["draft1", "pub1"]) await CacheManager.save(id, fakeMethod(id));
    await adApi.publishDraft("draft1");
    expect(await CacheManager.load("draft1")).toBeNull();
    expect(await CacheManager.load("pub1")).toBeNull();
  });
});

describe("AD definition cache (hydrator)", () => {
  test("numeric automationId hits the cache (F5) and is env-scoped (AD-05)", async () => {
    core.Config.setActiveEnv("nsm-dev");
    calls.length = 0;
    await ServiceHydrator.getDefinition(590 as unknown as string);
    await ServiceHydrator.getDefinition(590 as unknown as string);
    expect(calls).toEqual(["def:590"]); // second call served from cache
    core.Config.setActiveEnv("nsm-qa");
    await ServiceHydrator.getDefinition("590");
    expect(calls).toEqual(["def:590", "def:590"]); // other env → miss
    core.Config.setActiveEnv("nsm-dev");
  });

  test("hyphenated ids are not cached forever (AD-05)", async () => {
    const file = join(tmp, "cache", "definitions", "nsm-dev", "a-b.json");
    await Bun.write(file, JSON.stringify({ savedAt: Date.now() - 2 * 60 * 60 * 1000, data: { automationAPI: {} } }));
    calls.length = 0;
    await ServiceHydrator.getDefinition("a-b");
    expect(calls).toEqual(["def:a-b"]);
  });
});
