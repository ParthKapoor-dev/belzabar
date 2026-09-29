import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, type CacheResult, currentCacheEnv, ENTITY_CACHE_STALE_MS, ENTITY_CACHE_TTL_MS } from "@belzabar/core";
import { invalidateMethodIndexEntry } from "./method-finder";
import type { HydratedMethod } from "./types/common";

// Parsed-method cache, env-scoped by core `Cache`: `cache/methods/<env>/<uuid>.json`.
const methodCache = new Cache<HydratedMethod>({
  dir: join(BELZ_CONFIG_DIR, "cache", "methods"),
  staleMs: ENTITY_CACHE_STALE_MS,
  ttlMs: ENTITY_CACHE_TTL_MS,
});

/** Method uuids are case-insensitive hex; padded/mixed-case input must hit the same entry. */
function methodCacheKey(uuid: string): string {
  return uuid.trim().toLowerCase();
}

export class CacheManager {
  /** Directory backing the method cache for the active env (for refresh-lock sidecar files). */
  static get dir(): string {
    return methodCache.dir;
  }

  static async save(uuid: string, data: HydratedMethod, env?: string): Promise<void> {
    return methodCache.save(methodCacheKey(uuid), data, env);
  }

  static async load(uuid: string, env?: string): Promise<HydratedMethod | null> {
    return methodCache.load(methodCacheKey(uuid), env);
  }

  /** Stale-while-revalidate load — flags entries past the soft TTL as stale. */
  static async loadSwr(uuid: string, env?: string): Promise<CacheResult<HydratedMethod> | null> {
    return methodCache.loadSwr(methodCacheKey(uuid), env);
  }

  /**
   * Drop a cached method after belz wrote it (save/publish/delete/restore).
   * Also marks its method-index entry stale so `ad callers` re-reads it.
   * Never throws.
   */
  static async invalidate(uuid: string | null | undefined, env?: string): Promise<void> {
    if (!uuid) return;
    await invalidateMethodIndexEntry(env ?? currentCacheEnv(), uuid);
    return methodCache.invalidate(methodCacheKey(uuid), env);
  }
}
