import { describe, expect, test } from "bun:test"
import { SWR_CACHE_MAX, makeCacheKey, setSwrCacheEntry } from "./swr-cache"

describe("makeCacheKey", () => {
  test("namespaces by env so the same query in two envs is two entries", () => {
    expect(makeCacheKey("nsm-dev", "documents")).toBe("nsm-dev::documents")
    expect(makeCacheKey("nsm-qa", "documents")).toBe("nsm-qa::documents")
    expect(makeCacheKey("nsm-dev", "documents")).not.toBe(
      makeCacheKey("nsm-qa", "documents"),
    )
  })

  test("preserves the literal query, including whitespace inside it", () => {
    expect(makeCacheKey("nsm-dev", "user info")).toBe("nsm-dev::user info")
  })

  test("distinguishes empty-query from missing-env edge cases", () => {
    expect(makeCacheKey("", "x")).toBe("::x")
    expect(makeCacheKey("x", "")).toBe("x::")
  })
})

describe("setSwrCacheEntry", () => {
  test("inserts a new entry", () => {
    const cache = new Map<string, number>()
    setSwrCacheEntry(cache, "a", 1)
    expect(cache.get("a")).toBe(1)
    expect(cache.size).toBe(1)
  })

  test("overwrites an existing entry without growing the cache", () => {
    const cache = new Map<string, number>()
    setSwrCacheEntry(cache, "a", 1)
    setSwrCacheEntry(cache, "a", 2)
    expect(cache.get("a")).toBe(2)
    expect(cache.size).toBe(1)
  })

  test("evicts the oldest entry when the cache exceeds the max", () => {
    const cache = new Map<string, number>()
    setSwrCacheEntry(cache, "a", 1, 2)
    setSwrCacheEntry(cache, "b", 2, 2)
    expect(cache.size).toBe(2)

    setSwrCacheEntry(cache, "c", 3, 2)
    expect(cache.size).toBe(2)
    expect(cache.has("a")).toBe(false) // oldest evicted
    expect(cache.has("b")).toBe(true)
    expect(cache.has("c")).toBe(true)
  })

  test("re-insertion promotes a key so it's no longer the oldest", () => {
    const cache = new Map<string, number>()
    setSwrCacheEntry(cache, "a", 1, 2)
    setSwrCacheEntry(cache, "b", 2, 2)
    // Promote "a" by re-inserting; now "b" is the oldest.
    setSwrCacheEntry(cache, "a", 11, 2)
    setSwrCacheEntry(cache, "c", 3, 2)

    expect(cache.get("a")).toBe(11)
    expect(cache.has("b")).toBe(false) // b should be evicted, not a
    expect(cache.has("c")).toBe(true)
  })

  test("default max is SWR_CACHE_MAX (50)", () => {
    const cache = new Map<string, number>()
    for (let i = 0; i < SWR_CACHE_MAX + 5; i += 1) {
      setSwrCacheEntry(cache, `k${i}`, i)
    }
    expect(cache.size).toBe(SWR_CACHE_MAX)
    // Earliest 5 keys should be evicted.
    expect(cache.has("k0")).toBe(false)
    expect(cache.has("k4")).toBe(false)
    expect(cache.has("k5")).toBe(true)
    expect(cache.has(`k${SWR_CACHE_MAX + 4}`)).toBe(true)
  })

  test("simulates an SWR session: search, re-search, env switch", () => {
    const cache = new Map<string, { count: number }>()

    const k1 = makeCacheKey("nsm-dev", "documents")
    setSwrCacheEntry(cache, k1, { count: 10 })

    // Re-query same (env, query) — hit
    expect(cache.has(k1)).toBe(true)
    expect(cache.get(k1)?.count).toBe(10)

    // Switch env — same query but cache key differs → miss
    const k2 = makeCacheKey("nsm-qa", "documents")
    expect(cache.has(k2)).toBe(false)

    setSwrCacheEntry(cache, k2, { count: 7 })

    // Both are now cached; switching back to dev still hits.
    expect(cache.has(k1)).toBe(true)
    expect(cache.get(k1)?.count).toBe(10)
  })
})
