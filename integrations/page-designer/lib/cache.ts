import { Cache, ENTITY_CACHE_STALE_MS, ENTITY_CACHE_TTL_MS } from "@belzabar/core";
import { PAGE_CACHE_DIR } from "@belzabar/core/platform";
import { pdApi } from "./api/index";
import type { RawPageResponse } from "./types/wire";

// Env-scoped by core `Cache`: `cache/pages/<env>/<id>.json`. Pages and
// components share one endpoint (GET /pages/{id}) and one cache.
const pdCache = new Cache<RawPageResponse>({
  dir: PAGE_CACHE_DIR,
  staleMs: ENTITY_CACHE_STALE_MS,
  ttlMs: ENTITY_CACHE_TTL_MS,
});

/**
 * Directory backing the PD cache for the active env (for refresh-lock sidecar
 * files). A function, not a constant: the env is only known after `--env` is parsed.
 */
export function pdCacheDir(env?: string): string {
  return pdCache.dirFor(env);
}

/** Drop cached page/component configs (call after save/publish/restore). Never throws. */
export async function invalidatePageCache(ids: string | null | undefined | Array<string | null | undefined>, env?: string): Promise<void> {
  for (const id of new Set(Array.isArray(ids) ? ids : [ids])) {
    if (id) await pdCache.invalidate(id, env);
  }
}

/** Cached (TTL) page/component fetch; `force` bypasses the cache. */
export async function cachedFetchPageConfig(pageId: string, force = false): Promise<RawPageResponse | null> {
  if (!force) {
    const cached = await pdCache.load(pageId);
    if (cached) return cached;
  }
  const data = await pdApi.fetchPage(pageId);
  if (data) await pdCache.save(pageId, data);
  return data;
}

/** Where a config came from: in-TTL cache, a stale-but-usable cache hit, or a fresh fetch. */
export type ConfigSource = "cache" | "stale" | "fresh";

export interface SwrConfigResult {
  data: RawPageResponse | null;
  source: ConfigSource;
}

/**
 * Stale-while-revalidate page/component fetch. Returns cached data immediately
 * when present (flagging it `stale` once past the soft TTL); only fetches
 * synchronously on a miss, hard expiry, or `force`.
 */
export async function cachedFetchPageConfigSwr(pageId: string, force = false): Promise<SwrConfigResult> {
  if (!force) {
    const cached = await pdCache.loadSwr(pageId);
    if (cached) return { data: cached.data, source: cached.stale ? "stale" : "cache" };
  }
  const data = await pdApi.fetchPage(pageId);
  if (data) await pdCache.save(pageId, data);
  return { data, source: "fresh" };
}
