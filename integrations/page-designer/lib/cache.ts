import { join } from "path";
import { Cache, BELZ_CONFIG_DIR } from "@belzabar/core";
import { fetchPageConfig, fetchComponentConfig } from "./api/index";
import type { RawPageResponse } from "./types/wire";

// Legacy name kept so existing imports resolve; aliased to RawPageResponse.
type PageConfigResponse = RawPageResponse;

const pdCache = new Cache<PageConfigResponse>({
  dir: join(BELZ_CONFIG_DIR, "cache", "pages"),
  staleMs: 5 * 60 * 1000, // soft TTL — past this, serve stale + refresh in background
  ttlMs: 60 * 60 * 1000, // hard TTL — past this, block on a fresh fetch
});

/** Directory backing the PD cache (for refresh-lock sidecar files). */
export const PD_CACHE_DIR = pdCache.dir;

export async function cachedFetchPageConfig(pageId: string, force = false): Promise<PageConfigResponse | null> {
  if (!force) {
    const cached = await pdCache.load(pageId);
    if (cached) return cached;
  }
  const data = await fetchPageConfig(pageId);
  if (data) await pdCache.save(pageId, data);
  return data;
}

export async function cachedFetchComponentConfig(componentId: string, force = false): Promise<PageConfigResponse | null> {
  if (!force) {
    const cached = await pdCache.load(componentId);
    if (cached) return cached;
  }
  const data = await fetchComponentConfig(componentId);
  if (data) await pdCache.save(componentId, data);
  return data;
}

/** Where a config came from: in-TTL cache, a stale-but-usable cache hit, or a fresh fetch. */
export type ConfigSource = "cache" | "stale" | "fresh";

export interface SwrConfigResult {
  data: PageConfigResponse | null;
  source: ConfigSource;
}

/**
 * Stale-while-revalidate page fetch. Returns cached data immediately when present
 * (flagging it `stale` once past the soft TTL); only fetches synchronously on a
 * miss, hard expiry, or `force`.
 */
export async function cachedFetchPageConfigSwr(pageId: string, force = false): Promise<SwrConfigResult> {
  if (!force) {
    const cached = await pdCache.loadSwr(pageId);
    if (cached) return { data: cached.data, source: cached.stale ? "stale" : "cache" };
  }
  const data = await fetchPageConfig(pageId);
  if (data) await pdCache.save(pageId, data);
  return { data, source: "fresh" };
}

/** Stale-while-revalidate component fetch — see {@link cachedFetchPageConfigSwr}. */
export async function cachedFetchComponentConfigSwr(componentId: string, force = false): Promise<SwrConfigResult> {
  if (!force) {
    const cached = await pdCache.loadSwr(componentId);
    if (cached) return { data: cached.data, source: cached.stale ? "stale" : "cache" };
  }
  const data = await fetchComponentConfig(componentId);
  if (data) await pdCache.save(componentId, data);
  return { data, source: "fresh" };
}
