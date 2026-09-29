// On-disk finder index (AD method finder, PD page finder): one listing of a
// whole env, rebuilt on demand and reused for FINDER_INDEX_TTL_MS.
//
// Stored at `cache/<name>/index-v1-<env>.json`. The key already carries the
// env, so the Cache is not env-scoped, and a loaded index is only reused when
// the env it records matches the active one.

import { join } from "path";
import { Cache, FINDER_INDEX_TTL_MS } from "./cache";
import { BELZ_CONFIG_DIR, Config } from "./config";

interface FinderIndexStore<T extends { env: string }> {
  /** The directory holding the index (sidecar caches may live beside it). */
  readonly dir: string;
  load(env: string): Promise<T | null>;
  save(index: T): Promise<void>;
  drop(env: string): Promise<void>;
  /**
   * The active env's index: the cached one unless `refresh`, or it was built
   * for another env, or `reuse(cached)` says no; otherwise `build()` and save.
   */
  loadOrBuild(opts: { refresh: boolean; build: () => Promise<T>; reuse?: (cached: T) => boolean }): Promise<{ index: T; source: "cache" | "fresh" }>;
}

export function finderIndexStore<T extends { env: string }>(name: string): FinderIndexStore<T> {
  const dir = join(BELZ_CONFIG_DIR, "cache", name);
  const cache = new Cache<T>({ dir, ttlMs: FINDER_INDEX_TTL_MS, envScoped: false });
  const key = (env: string) => `index-v1-${env}`;
  const store: FinderIndexStore<T> = {
    dir,
    load: (env) => cache.load(key(env)),
    save: (index) => cache.save(key(index.env), index),
    drop: (env) => cache.invalidate(key(env)),
    async loadOrBuild({ refresh, build, reuse }) {
      const env = Config.activeEnv.name;
      if (!refresh) {
        const cached = await store.load(env);
        if (cached && cached.env === env && (reuse?.(cached) ?? true)) return { index: cached, source: "cache" };
      }
      const index = await build();
      await cache.save(key(env), index);
      return { index, source: "fresh" };
    },
  };
  return store;
}
