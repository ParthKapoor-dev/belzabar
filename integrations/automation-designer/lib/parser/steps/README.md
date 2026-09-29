# lib/parser/steps — step parsing and service classification

| File | Contents |
|---|---|
| `classify.ts` | `ServiceIdentity`, `ServiceResolver`, `resolveStepIdentity` (injected resolver first, then the V2 wire names `serviceName`/`methodName`) and `classifyService` (identity → step family). |
| `v1.ts` | `parseV1Step`: `activeTab.id === "customCode"` → `CUSTOM_CODE`; an existing-service step is classified by the service it calls; neither → `UNKNOWN` with a `reason`. |
| `v2.ts` | `parseV2Step` (by `properties.type` and the wire's service names) and `parseV2Loop`. |
| `shared.ts` | V1 mapping-tree walkers (`walkMappingTree`, `findMappingByInputId`) for the V1 step parser. |

## Classification

A step's family comes from the service it calls, never from a numeric id (those differ per
env, and there are no built-in per-env tables):

| Service (system / API) | Kind |
|---|---|
| `db_service` (label `Database.SQL`): `data.read`/`select`, `data.add`/`insert`, `data.update`/`update`, `data.delete`/`delete`, `schema.modify` | `SQL` |
| `Helpers.Legacy` / `echo` | `SPEL_ECHO` |
| `Cache.Redis` / `get`, `set`, `remove` | `REDIS_GET`, `REDIS_SET`, `REDIS_REMOVE` |
| anything else, or no identity | `EXISTING_SERVICE` |

Without an identity a step stays `EXISTING_SERVICE`: the parser never guesses SQL or SpEL,
because the save overlay only writes `sql` / `expression` into steps of those kinds.

## Decoding

- Custom code: decoded with the strict base64 decoder ([`../../base64.ts`](../../base64.ts)) into
  `source`; plain text is left alone. `sourceEncoding` is `BASE_64` or `NONE`.
- SQL: the query slot whose `encodingType` is `BASE_64` is decoded into `sql`
  (`sqlEncoding`).

Up: [`../README.md`](../README.md)
