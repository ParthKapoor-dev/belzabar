import { join } from "path";
import { Cache, BELZ_CONFIG_DIR, type CacheResult } from "@belzabar/core";
import type { HydratedMethod } from "./types/common";

const methodCache = new Cache<HydratedMethod>({
  dir: join(BELZ_CONFIG_DIR, "cache", "methods"),
  staleMs: 5 * 60 * 1000, // soft TTL — past this, serve stale + refresh in background
  ttlMs: 60 * 60 * 1000, // hard TTL — past this, block on a fresh fetch
});

export class CacheManager {
  /** Directory backing the method cache (for refresh-lock sidecar files). */
  static readonly dir = methodCache.dir;

  static async save(uuid: string, data: HydratedMethod): Promise<void> {
    return methodCache.save(uuid, data);
  }

  static async load(uuid: string): Promise<HydratedMethod | null> {
    return methodCache.load(uuid);
  }

  /** Stale-while-revalidate load — flags entries past the soft TTL as stale. */
  static async loadSwr(uuid: string): Promise<CacheResult<HydratedMethod> | null> {
    return methodCache.loadSwr(uuid);
  }
}
