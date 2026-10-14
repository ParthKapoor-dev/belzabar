// Evict the platform's compiled copy of a chain after a write.
//
// After a save the runtime may keep executing the previously compiled chain.
// On a dev env `/rest/api/cache/invalidate` alone did NOT evict it; only both
// routes together did. On micro-AD tenants the
// monolith route answers 200 without owning the cache. So: POST to every route,
// succeed if ANY answers 2xx, report each. Mirrors `wi-impl cache` and the team's
// save-and-test.py.
//
// Never called with an empty `uuids` list: the server reads that as "flush the
// whole organisation".

import { apiFetch } from "@belzabar/core";

export const COMPILED_CACHE_ROUTES = [
  "/rest/api/cache/invalidate",
  "/rest/api/automations/cache/invalidate",
] as const;

interface CacheRouteResult {
  path: string;
  ok: boolean;
  status: number | null;
  error?: string;
}

export interface CompiledCacheResult {
  /** At least one route answered 2xx. */
  ok: boolean;
  uuids: string[];
  routes: CacheRouteResult[];
}

/** POST `{uuids, type:"AUTOMATION"}` to both routes. Never throws. */
export async function invalidateCompiledCache(uuids: Array<string | null | undefined>): Promise<CompiledCacheResult> {
  const list = [...new Set(uuids.map((u) => (typeof u === "string" ? u.trim() : "")).filter((u) => u.length > 0))];
  if (list.length === 0) {
    // Refuse rather than flush the org; callers always know their uuid.
    return { ok: false, uuids: [], routes: [] };
  }
  const body = JSON.stringify({ uuids: list, type: "AUTOMATION" });
  const routes: CacheRouteResult[] = [];
  for (const path of COMPILED_CACHE_ROUTES) {
    try {
      const res = await apiFetch(path, {
        method: "POST",
        authMode: "Bearer",
        headers: { "Content-Type": "application/json" },
        body,
      });
      await res.text().catch(() => "");
      routes.push({ path, ok: res.ok, status: res.status });
    } catch (err) {
      routes.push({ path, ok: false, status: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: routes.some((r) => r.ok), uuids: list, routes };
}
