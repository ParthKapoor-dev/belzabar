// Server-side cache invalidation of the active env, shared by `wi-impl cache`
// and `migrate run` (which clears the TARGET env after a build).
//
// Both routes are POSTed on every request. On a tenant routed through micro-AD
// the monolith route answers 200 without evicting the compiled chain; the
// `/automations/` route owns it there (and 404/500s on a monolith tenant). A
// 2xx proves the endpoint exists, not that it held the cache, so call both,
// count a request as sent if ANY route returns 2xx, and report each route.
//
// An env can run several app servers behind one load balancer, and one request
// reaches one of them: right after a migration, a single clear left about half
// of the requests on the old compiled chain. So a clear can be repeated
// (`rounds`), with a pause between rounds, and is `verified` only when every
// round reached a route. A 2xx still cannot prove that every server evicted.

import { apiFetch } from "../http/api";
import { sleep } from "../http/transport";

export const CACHE_INVALIDATE_PATHS = [
  "/rest/api/cache/invalidate",
  "/rest/api/automations/cache/invalidate",
] as const;

export interface CacheRouteResult {
  path: string;
  ok: boolean;
  status: number | null;
  response?: unknown;
  error?: string;
}

export interface CacheClearRound {
  round: number;
  /** At least one route answered 2xx. */
  ok: boolean;
  routes: CacheRouteResult[];
}

export interface ServerCacheClear {
  type: string;
  uuids: string[];
  rounds: CacheClearRound[];
  /** Rounds in which at least one route answered 2xx. */
  okRounds: number;
  /** Every round reached a route (okRounds === rounds.length). */
  verified: boolean;
}

type Fetcher = (path: string, options: Parameters<typeof apiFetch>[1]) => Promise<Response>;

/** Pause between repeated rounds, so they spread over the env's servers. */
export const CACHE_REPEAT_DELAY_MS = 1000;

async function readBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 1024);
    }
  } catch {
    return "(response body unreadable)";
  }
}

/**
 * POST the body to every invalidate route of the active env. Never throws.
 * An empty `uuids` list flushes the whole organisation's cache of that type:
 * only build one deliberately.
 */
export async function invalidateOnAllRoutes(
  body: { uuids: string[]; type: string },
  fetcher: Fetcher = apiFetch,
): Promise<CacheRouteResult[]> {
  const results: CacheRouteResult[] = [];
  for (const path of CACHE_INVALIDATE_PATHS) {
    try {
      const response = await fetcher(path, {
        method: "POST",
        authMode: "Bearer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      results.push({ path, ok: response.ok, status: response.status, response: await readBody(response) });
    } catch (err) {
      results.push({ path, ok: false, status: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/**
 * Clear `uuids` from the active env's server cache, `repeat` times (at least
 * once). Never throws. An empty list would flush the organisation's whole
 * cache of `type`: it is refused (zero rounds, not verified) unless `all` says so.
 */
export async function clearServerCache(
  uuids: readonly string[],
  options: {
    type?: string;
    repeat?: number;
    delayMs?: number;
    fetcher?: Fetcher;
    onRound?: (round: CacheClearRound, of: number) => void;
    /** Allow the empty list, i.e. a deliberate org-wide flush of `type`. */
    all?: boolean;
  } = {},
): Promise<ServerCacheClear> {
  const type = options.type ?? "AUTOMATION";
  const list = [...new Set(uuids.map((u) => u.trim()).filter(Boolean))];
  const repeat = Math.max(1, Math.floor(options.repeat ?? 1));
  const rounds: CacheClearRound[] = [];
  if (list.length > 0 || options.all) {
    for (let i = 1; i <= repeat; i++) {
      if (i > 1) await sleep(options.delayMs ?? CACHE_REPEAT_DELAY_MS);
      const routes = await invalidateOnAllRoutes({ uuids: list, type }, options.fetcher);
      const round = { round: i, ok: routes.some((r) => r.ok), routes };
      rounds.push(round);
      options.onRound?.(round, repeat);
    }
  }
  const okRounds = rounds.filter((r) => r.ok).length;
  return { type, uuids: list, rounds, okRounds, verified: rounds.length > 0 && okRounds === rounds.length };
}
