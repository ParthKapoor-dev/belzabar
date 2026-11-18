// The AD references in PD pages and components: every httpRequest that runs
// `/chain/execute/<uuid>` (draft and published pages, components), as a slim index
// (fresh 1 h, kept 7 days as a fallback). `wi-impl ad callers --pd`
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

// Fresh for 1 h; kept 7 days as the fallback when a listing fails.
const pdRefsCache = new Cache<PdRefItem[]>({ dir: join(BELZ_CONFIG_DIR, "cache", "pd-ad-refs"), ttlMs: 7 * 24 * 60 * 60 * 1000, staleMs: 60 * 60 * 1000 });
/** `index-v2`: the index gained published pages (an `index` entry lacks them). */
const PD_REFS_KEY = "index-v2";

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

interface PdRefsLoad {
  items: PdRefItem[];
  /** `stale`: a listing failed and the last complete index (older than 1 h) was used instead. */
  source: "cache" | "fresh" | "stale";
  /** Minutes since the index was built (cache / stale). */
  ageMinutes?: number;
  /** Listings that failed: their pages / components are missing unless `source` is stale. */
  failed?: Array<{ listing: string; code: string; message: string }>;
}

/**
 * The index: cached for 1 h, rebuilt from three listings (draft pages, published pages,
 * components). A failed listing does not lose the others: the last complete index (kept
 * 7 days) is used instead when there is one, else the listings that worked, with
 * `failed` naming the rest. Only when every listing fails and nothing is cached does it throw.
 */
export async function loadPdRefs(refresh: boolean): Promise<PdRefsLoad> {
  const cached = await pdRefsCache.loadSwr(PD_REFS_KEY);
  const age = cached ? Math.round((Date.now() - cached.savedAt) / 60000) : undefined;
  if (!refresh && cached && !cached.stale) return { items: cached.data, source: "cache", ageMinutes: age };
  lifecycle.notice("Listing PD pages and components (with configuration)…");
  const listings = [
    { listing: "draft pages", type: "PAGE" as const, load: () => fetchPagesWithConfig("DRAFT") },
    { listing: "published pages", type: "PAGE" as const, load: () => fetchPagesWithConfig("PUBLISHED") },
    { listing: "components", type: "COMPONENT" as const, load: async () => (await pdApi.fetchAllComponents()) as RawPageResponse[] },
  ];
  const settled = await Promise.allSettled(listings.map((l) => l.load()));
  const items: PdRefItem[] = [];
  const failed: NonNullable<PdRefsLoad["failed"]> = [];
  settled.forEach((s, i) => {
    const l = listings[i]!;
    if (s.status === "rejected") {
      const e = s.reason as { code?: string; message?: string };
      failed.push({ listing: l.listing, code: e?.code ?? "PD_LIST_FAILED", message: e?.message ?? String(s.reason) });
      return;
    }
    for (const p of s.value) {
      const r = pdRefsOf(p, l.type);
      if (r) items.push(r);
    }
  });
  if (failed.length === 0) {
    await pdRefsCache.save(PD_REFS_KEY, items);
    return { items, source: "fresh" };
  }
  if (cached) return { items: cached.data, source: "stale", ageMinutes: age, failed };
  if (failed.length === listings.length) throw (settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason;
  return { items, source: "fresh", failed };
}
