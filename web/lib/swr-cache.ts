// Bounded FIFO cache for stale-while-revalidate. Used by the unified search
// modal to render previously-seen (env, query) results instantly while a
// fresh request runs in the background. Generic over the value type so
// non-search consumers can reuse the same eviction policy.

export const SWR_CACHE_MAX = 50

export function makeCacheKey(env: string, query: string): string {
  return `${env}::${query}`
}

export function setSwrCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  max: number = SWR_CACHE_MAX,
): void {
  // Re-insert so this key becomes the most-recent in iteration order; JS
  // Maps preserve insertion order, so evicting the first key drops the
  // oldest entry.
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}
