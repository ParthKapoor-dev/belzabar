import { join } from "path";
import { Cache, BELZ_CONFIG_DIR, type CacheResult } from "@belzabar/core";
import type { HydratedMethod } from "./types/common";

// Env-scoped by core `Cache`: `cache/methods/<env>/<uuid>.json`. Legacy
// unscoped `cache/methods/<uuid>.json` files are simply never read again.
const methodCache = new Cache<HydratedMethod>({
  dir: join(BELZ_CONFIG_DIR, "cache", "methods"),
  staleMs: 5 * 60 * 1000, // soft TTL — past this, serve stale + refresh in background
  ttlMs: 60 * 60 * 1000, // hard TTL — past this, block on a fresh fetch
});

/** Method uuids are case-insensitive hex; padded/mixed-case input must hit the same entry. */
export function methodCacheKey(uuid: string): string {
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

  /** Drop a cached method (call after save/publish/restore). Never throws. */
  static async invalidate(uuid: string | null | undefined, env?: string): Promise<void> {
    if (!uuid) return;
    return methodCache.invalidate(methodCacheKey(uuid), env);
  }
}
