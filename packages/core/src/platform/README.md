# core/src/platform

`@belzabar/core/platform`: code specific to the Expertly platform that both the AD and PD
integrations need. Generic helpers belong in `src/`, not here.

| File | Contents |
|------|----------|
| `ids.ts` | `resolveMethodRef` (canonical method uuid), `normalizeUuid`, `trimUuidPadding`, `isHex32`, `isEntityId`, `canonicalUuid` |
| `entities.ts` | `fetchRawEntity`, `fetchRawChain`, `fetchRawPage`, and the paths `adChainPath`, `pdPagePath` |
| `entity-cache.ts` | `METHOD_CACHE_DIR`, `PAGE_CACHE_DIR`, `METHOD_FINDER_INDEX`, `methodIndexDirtyKey`: the AD/PD entity cache layout; `markMethodIndexDirty`; `invalidateEntityCache(kind, env, ids)` (best effort, used by `migrate run` for the target env) |
| `server-cache.ts` | `CACHE_INVALIDATE_PATHS`, `invalidateOnAllRoutes` (one POST to both invalidate routes of the active env), `clearServerCache` (repeated rounds, `verified` when every round reached a route); used by `wi-impl cache` and `migrate run` |
| `index.ts` | Re-exports them |

## Contracts

- **Ids.** The platform spells uuids several ways: 32 hex padded with trailing spaces, dashed
  36-character uuids, mixed case, or a whole editor URL. Every AD command that takes a method
  uuid goes through `resolveMethodRef`, which returns trimmed, lower-case, undashed 32 hex (or
  throws `INVALID_UUID`), so the request path, cache key and echoed value always agree.
  `trimUuidPadding` deep-copies a wire value with the padding trimmed from uuid-shaped strings.
- **Not found.** For the raw chain and page GETs, "not found" is a 404 **or** a 2xx with an
  empty / `null` body (the chain GET answers an unknown uuid with 200 and no body).
  `fetchRawEntity` returns `{found: false, reason}` for both and leaves the error codes to the
  caller (`onError` for other non-OK responses, optional `badJson`).

- **Server cache.** An env can run several servers behind one load balancer; one invalidate
  request reaches one of them. `clearServerCache` repeats the request (`repeat`, 1 s apart) and
  reports every round. A 2xx shows the request was accepted, not that every server evicted.

Tests: `packages/core/tests/platform-ids.test.ts`, `platform-entities.test.ts`, `platform-entity-cache.test.ts`, `platform-server-cache.test.ts`.
Up: [src](../README.md).
