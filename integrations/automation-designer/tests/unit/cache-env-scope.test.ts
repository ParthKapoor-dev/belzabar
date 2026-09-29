// Regression tests for env-scoped AD caches.
// BELZ_HOME is set to a tmp dir by the bunfig.toml test preload before
// @belzabar/core is first imported; beforeAll asserts it so nothing can ever
// touch the real ~/.belz.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as core from "@belzabar/core";
import { fakeFetch, withTempEnvConfig, type FakeFetch, type RecordedRequest, type TempEnvConfig } from "@belzabar/core/testing";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { adApi } from "../../lib/api/index";

// Fake network through fakeFetch, never mock.module: Bun module mocks are
// process-wide and leaked a fake publishDraft into later test files.
const tmp = core.BELZ_CONFIG_DIR;
const calls: string[] = [];
let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;

beforeAll(() => {
  if (!tmp.startsWith(tmpdir())) throw new Error(`refusing to run: BELZ_CONFIG_DIR=${tmp} is not a test tmp dir`);
});
beforeEach(() => {
  cfg = withTempEnvConfig({
    envs: { "orb-dev": { url: "https://orb-dev.test" }, "orb-qa": { url: "https://orb-qa.test" }, e1: { url: "https://e1.test" } },
    activeEnv: "orb-dev",
  });
  ff = fakeFetch([
    {
      method: "POST",
      url: /\/chain\/[^/]+\/publish$/,
      response: (req: RecordedRequest) => {
        const draft = req.url.split("/chain/")[1]!.split("/")[0]!;
        calls.push(`publish:${draft}`);
        return { referenceId: "pub1" };
      },
    },
    {
      method: "GET",
      url: /\/rest\/api\/automations\/[^/?]+\?basicinfo=false$/,
      response: (req: RecordedRequest) => {
        const id = req.url.split("/automations/")[1]!.split("?")[0]!;
        calls.push(`def:${id}`);
        return { automationAPI: { id } };
      },
    },
  ]).install();
});
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
});
afterAll(() => rmSync(join(tmp, "cache"), { recursive: true, force: true }));

const fakeMethod = (tag: string) => ({ uuid: tag, sourceVersion: "v1" }) as any;

describe("AD method cache", () => {
  test("is env-scoped", async () => {
    await CacheManager.save("aaaa", fakeMethod("dev-body"), "orb-dev");
    expect((await CacheManager.load("aaaa", "orb-dev"))?.uuid).toBe("dev-body");
    expect(await CacheManager.load("aaaa", "orb-qa")).toBeNull();
    expect(existsSync(join(tmp, "cache", "methods", "orb-dev", "aaaa.json"))).toBe(true);
  });

  test("padded / upper-case uuids map to one trimmed lower-case file", async () => {
    await CacheManager.save("  4BF5E00    ", fakeMethod("p"), "e1");
    expect(readdirSync(join(tmp, "cache", "methods", "e1"))).toEqual(["4bf5e00.json"]);
    expect((await CacheManager.loadSwr("4bf5e00", "e1"))?.data.uuid).toBe("p");
  });

  test("dir follows the active env", () => {
    core.Config.setActiveEnv("orb-qa");
    expect(CacheManager.dir).toBe(join(tmp, "cache", "methods", "orb-qa"));
    core.Config.setActiveEnv("orb-dev");
    expect(CacheManager.dir).toBe(join(tmp, "cache", "methods", "orb-dev"));
  });

  test("adApi.publishDraft invalidates touched uuids", async () => {
    core.Config.setActiveEnv("orb-dev");
    for (const id of ["draft1", "pub1"]) await CacheManager.save(id, fakeMethod(id));
    await adApi.publishDraft("draft1");
    expect(calls).toContain("publish:draft1");
    expect(await CacheManager.load("draft1")).toBeNull();
    expect(await CacheManager.load("pub1")).toBeNull();
  });
});

describe("AD definition cache (hydrator)", () => {
  test("numeric automationId hits the cache and is env-scoped", async () => {
    core.Config.setActiveEnv("orb-dev");
    calls.length = 0;
    await ServiceHydrator.getDefinition(590 as unknown as string);
    await ServiceHydrator.getDefinition(590 as unknown as string);
    expect(calls).toEqual(["def:590"]); // second call served from cache
    core.Config.setActiveEnv("orb-qa");
    await ServiceHydrator.getDefinition("590");
    expect(calls).toEqual(["def:590", "def:590"]); // other env → miss
    core.Config.setActiveEnv("orb-dev");
  });

  test("hyphenated ids are not cached forever", async () => {
    const file = join(tmp, "cache", "definitions", "orb-dev", "a-b.json");
    await Bun.write(file, JSON.stringify({ savedAt: Date.now() - 2 * 60 * 60 * 1000, data: { automationAPI: {} } }));
    calls.length = 0;
    await ServiceHydrator.getDefinition("a-b");
    expect(calls).toEqual(["def:a-b"]);
  });
});
