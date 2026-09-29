import { afterEach, describe, expect, test } from "bun:test";
import { finderIndexStore } from "../src/finder-index";
import { withTempEnvConfig, type TempEnvConfig } from "../src/testing";

interface Idx { env: string; n: number }

let cfg: TempEnvConfig | null = null;
afterEach(() => {
  cfg?.restore();
  cfg = null;
});
const useEnv = (env: string) => {
  cfg?.restore();
  cfg = withTempEnvConfig({ envs: { [env]: { url: "https://x.test" } }, activeEnv: env });
};

describe("finderIndexStore", () => {
  test("builds once, then serves the cached index for the same env", async () => {
    useEnv("t-fi-a");
    const store = finderIndexStore<Idx>(`fi-${Math.random().toString(36).slice(2)}`);
    let builds = 0;
    const build = async () => ({ env: "t-fi-a", n: ++builds });
    expect(await store.loadOrBuild({ refresh: false, build })).toEqual({ index: { env: "t-fi-a", n: 1 }, source: "fresh" });
    expect(await store.loadOrBuild({ refresh: false, build })).toEqual({ index: { env: "t-fi-a", n: 1 }, source: "cache" });
    expect((await store.loadOrBuild({ refresh: true, build })).source).toBe("fresh");
    expect(builds).toBe(2);
  });

  test("reuse=false and a missing index rebuild; drop removes it", async () => {
    useEnv("t-fi-b");
    const store = finderIndexStore<Idx>(`fi-${Math.random().toString(36).slice(2)}`);
    const build = async () => ({ env: "t-fi-b", n: 7 });
    await store.loadOrBuild({ refresh: false, build });
    expect((await store.loadOrBuild({ refresh: false, build, reuse: () => false })).source).toBe("fresh");
    expect(await store.load("t-fi-b")).toEqual({ env: "t-fi-b", n: 7 });
    await store.drop("t-fi-b");
    expect(await store.load("t-fi-b")).toBeNull();
  });

  test("reuse(cached) decides whether a cached index is kept", async () => {
    useEnv("t-fi-c");
    const store = finderIndexStore<Idx>(`fi-${Math.random().toString(36).slice(2)}`);
    await store.save({ env: "t-fi-c", n: 1 });
    const res = await store.loadOrBuild({ refresh: false, build: async () => ({ env: "t-fi-c", n: 2 }), reuse: (c) => c.n > 1 });
    expect(res).toEqual({ index: { env: "t-fi-c", n: 2 }, source: "fresh" });
  });
});
