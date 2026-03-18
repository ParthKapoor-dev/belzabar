import { join } from "path";
import { Cache, BELZ_CONFIG_DIR } from "@belzabar/core";
import { fetchPageConfig, fetchComponentConfig } from "./api";
import type { PageConfigResponse } from "./types";

const pdCache = new Cache<PageConfigResponse>({
  dir: join(BELZ_CONFIG_DIR, "cache", "pages"),
  ttlMs: 5 * 60 * 1000,
});

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
