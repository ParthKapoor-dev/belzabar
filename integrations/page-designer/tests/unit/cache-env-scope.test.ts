// Regression tests for env-scoped PD cache + lock file (CORE-3, PD-9, PD-12, F4, F22).
// BELZ_HOME is a tmp dir set by the bunfig.toml test preload; beforeAll refuses
// to run otherwise so nothing can touch the real ~/.belz. No network: pdApi
// lock calls are stubbed on the façade object.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let core: typeof import("@belzabar/core");
let pdCache: typeof import("../../lib/cache");
let withLock: typeof import("../../lib/lock").withLock;
let pdApi: typeof import("../../lib/api/index").pdApi;
let lockCmd: typeof import("../../commands/lock/index").default;
let root: string;
let envCfg: { restore(): void } | null = null;
const origLock: Record<string, unknown> = {};

beforeAll(async () => {
  core = await import("@belzabar/core");
  root = core.BELZ_CONFIG_DIR;
  if (!process.env.BELZ_HOME || root !== process.env.BELZ_HOME || !root.startsWith(tmpdir())) {
    throw new Error(`refusing to run: BELZ_CONFIG_DIR=${root} is not a test tmp dir (bunfig preload missing?)`);
  }
  const { withTempEnvConfig } = await import("@belzabar/core/testing");
  envCfg = withTempEnvConfig({
    envs: { "t-dev": { url: "https://d.test" }, "t-qa": { url: "https://q.test" }, "t-uat": { url: "https://u.test" } },
    defaultEnv: "t-dev",
  });
  pdCache = await import("../../lib/cache");
  ({ withLock } = await import("../../lib/lock"));
  ({ pdApi } = await import("../../lib/api/index"));
  lockCmd = (await import("../../commands/lock/index")).default;
  origLock.acquireLock = pdApi.acquireLock;
  origLock.releaseLock = pdApi.releaseLock;
  (pdApi as any).acquireLock = async () => {};
  (pdApi as any).releaseLock = async () => true;
});
afterEach(() => core.Config.setActiveEnv("t-dev"));
afterAll(() => {
  envCfg?.restore();
  Object.assign(pdApi, origLock);
  rmSync(join(root, "cache"), { recursive: true, force: true });
  rmSync(join(root, "pd-locks"), { recursive: true, force: true });
});

async function seed(env: string, id: string, configuration: string) {
  await Bun.write(
    join(root, "cache", "pages", env, `${id}.json`),
    JSON.stringify({ savedAt: Date.now(), data: { id, configuration } }),
  );
}

describe("PD page cache", () => {
  test("cache dir is per env and follows --env", () => {
    core.Config.setActiveEnv("t-qa");
    expect(pdCache.pdCacheDir()).toBe(join(root, "cache", "pages", "t-qa"));
    expect(pdCache.pdCacheDir("t-dev")).toBe(join(root, "cache", "pages", "t-dev"));
  });

  test("an entry cached for env A is served in A, never read in B", async () => {
    await seed("t-dev", "p1", "dev-config");
    core.Config.setActiveEnv("t-dev");
    expect((await pdCache.cachedFetchPageConfigSwr("p1")).data?.configuration).toBe("dev-config");
    // env B looks in its own dir — the dev file is not there.
    expect(existsSync(join(pdCache.pdCacheDir("t-qa"), "p1.json"))).toBe(false);
  });

  test("invalidatePageCache removes only that env's entry", async () => {
    await seed("t-dev", "p2", "d");
    await seed("t-qa", "p2", "q");
    await pdCache.invalidatePageCache("p2", "t-dev");
    expect(existsSync(join(root, "cache", "pages", "t-dev", "p2.json"))).toBe(false);
    expect(existsSync(join(root, "cache", "pages", "t-qa", "p2.json"))).toBe(true);
  });

  test("withLock (every PD write) invalidates the page cache (PD-12)", async () => {
    await seed("t-dev", "p3", "before-write");
    core.Config.setActiveEnv("t-dev");
    await withLock("p3", async () => "saved");
    expect(existsSync(join(root, "cache", "pages", "t-dev", "p3.json"))).toBe(false);

    await seed("t-dev", "p4", "before-failed-write");
    await expect(withLock("p4", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(join(root, "cache", "pages", "t-dev", "p4.json"))).toBe(false);
  });
});

describe("pd lock file (PD-9 / F22)", () => {
  test("uses the active env name, not 'default'", async () => {
    core.Config.setActiveEnv("t-qa");
    const res = await lockCmd.execute({ action: "acquire", pageId: "pg1" }, {} as any);
    expect((res as any).data.env).toBe("t-qa");
    expect(readdirSync(join(root, "pd-locks"))).toContain("t-qa.json");
    expect(readdirSync(join(root, "pd-locks"))).not.toContain("default.json");

    core.Config.setActiveEnv("t-uat");
    const status = await lockCmd.execute({ action: "status", pageId: null }, {} as any);
    expect((status as any).data).toMatchObject({ env: "t-uat", locks: [] });
  });
});
