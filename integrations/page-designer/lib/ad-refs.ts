// The AD references in PD pages and components: every httpRequest that runs
// `/chain/execute/<uuid>`, as a slim index (cached 1 h). `wi-impl ad callers --pd`
// matches a method against it.

import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, lifecycle } from "@belzabar/core";
import { fetchPagesWithConfig } from "./api/client";
import { pdApi } from "./api/index";
import { parsePage } from "./parser/index";
import type { RawPageResponse } from "./types/wire";

export interface PdRefItem {
  type: "PAGE" | "COMPONENT";
  id: string;
  name: string;
  status: string;
  calls: Array<{ adId: string; label: string; callId?: string; triggers?: string[] }>;
}

const pdRefsCache = new Cache<PdRefItem[]>({ dir: join(BELZ_CONFIG_DIR, "cache", "pd-ad-refs"), ttlMs: 60 * 60 * 1000 });

export function pdRefsOf(item: RawPageResponse, type: PdRefItem["type"]): PdRefItem | null {
  if (typeof item.configuration !== "string" || !item.configuration.includes("/chain/execute/")) return null;
  const page = parsePage(item);
  const calls = page.httpRequests
    .filter((c) => c.adId)
    .map((c) => ({
      adId: c.adId!.toLowerCase(),
      label: c.label.trim(),
      ...(c.callId ? { callId: c.callId } : {}),
      ...(c.triggers.length ? { triggers: c.triggers } : {}),
    }));
  if (calls.length === 0) return null;
  return { type, id: String(item.id), name: String(item.name ?? ""), status: String(item.status ?? "DRAFT"), calls };
}

export async function loadPdRefs(refresh: boolean): Promise<{ items: PdRefItem[]; source: "cache" | "fresh" }> {
  if (!refresh) {
    const cached = await pdRefsCache.load("index");
    if (cached) return { items: cached, source: "cache" };
  }
  lifecycle.notice("Listing PD pages and components (with configuration)…");
  const [pages, components] = await Promise.all([fetchPagesWithConfig(), pdApi.fetchAllComponents()]);
  const items: PdRefItem[] = [];
  for (const p of pages) {
    const r = pdRefsOf(p, "PAGE");
    if (r) items.push(r);
  }
  for (const c of components as RawPageResponse[]) {
    const r = pdRefsOf(c, "COMPONENT");
    if (r) items.push(r);
  }
  await pdRefsCache.save("index", items);
  return { items, source: "fresh" };
}
