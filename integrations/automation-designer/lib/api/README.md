# lib/api — AD wire clients

The HTTP layer for Automation Designer reads and the non-save writes. Commands call the
`adApi` façade; a few callers (save pipeline, validator, sql, trace, callers) use the
wire modules directly when they need a raw body or a V1-only route.

| File | Contents |
|---|---|
| `index.ts` | `adApi`: the façade. `fetchMethod(uuid, version)` dispatches to V1 or V2 and returns a parsed `HydratedMethod`; every other verb forwards to `v1.ts` / `changelog.ts`. |
| `v1.ts` | The V1 REST surface: raw chain GET, automation definitions, categories, services, child info, export/import, publish, test cases and suites, inline test (`testMethodMultipart`), history (list/get/restore through the platform's method-history service), `AD_LONG_OP_TIMEOUT_MS`. |
| `v2.ts` | `fetchRawMethod`: the raw `GET /chain/v2/{uuid}?basicInfo=false` body. V2 writes live in [`../save/api.ts`](../save/api.ts). |
| `changelog.ts` | Change notes: list/add/find by the numeric chain-definition id (not the uuid), plus `/users/me`. Reached only through `adApi`. |

## Contracts

- **V1 is the default read.** `fetch`, `show` and `show-code` take `--v2`
  ([`../args/common.ts`](../args/common.ts): `AD_V2_FLAG`, `apiVersionOf`) and pass the
  version to `adApi.fetchMethod`. `save`, `create` and `delete` always use V2; there is no
  V1 save route. Every other command calls the one route it needs.
- **Never call `response.json()`.** V1 routes go through `v1.ts:readJson` (status check +
  core `readJsonOrNull`): a 2xx with an empty or `null` body is `null`, a non-JSON body is
  `HTTP_BAD_JSON`. Other code uses core `readJsonOrNull` / `expectJson`. Several routes
  answer "nothing" with 200 and an empty body (an unknown chain uuid, a method without a
  test suite).
- **Not found.** A 404, or a 200 with an empty body, on a chain GET is `METHOD_NOT_FOUND`.
  V1 keeps serving soft-deleted records; the V2 route answers them as not found, which is
  why the read commands confirm a V1 read on V2 ([`../view-fetch.ts`](../view-fetch.ts)).
- **Long operations** (test, execute, publish, suites, restore) pass
  `AD_LONG_OP_TIMEOUT_MS` (10 min).
- Parsing needs the service resolver (see [`../parser/README.md`](../parser/README.md));
  a V1 body parsed without it misclassifies SQL and echo steps, so prefer
  `adApi.fetchMethod` over parsing a raw body yourself.

## V1 and V2 at a glance

| | V1 | V2 |
|---|---|---|
| Fetch | `GET /rest/api/automation/chain/{uuid}` | `GET /rest/api/automation/chain/v2/{uuid}?basicInfo=false` |
| Method JSON | `jsonDefinition` is a **stringified** JSON blob | flat JSON |
| Step identity | `activeTab.id` + env-local numeric `automationApiId` | `properties.type` + `serviceName`/`methodName` + portable `automationAPIId` uuid |
| Custom code | `code`, often base64 | `properties.customCode.inlineCode` |
| State | `automationState` | `metadata.state` |
| Save | not used by wi-impl | `POST /rest/api/automation/chain/v2` (live body + overlay) |
| Test | `POST /rest/api/automation/chain/test`, multipart `body=<JSON>`; runs an unsaved body | not used by wi-impl |
| Test-case update | `PUT /rest/api/automation/chain/testcases/{chainUuid}/{id}` | — |

Publish, export, import, categories and services have a single route.

## Platform facts the clients rely on

- A save must send the whole live V2 GET body with only the target leaves changed; a thin
  body is refused with `400 Invalid state`. The server ignores `metadata.version` (no
  optimistic locking), so wi-impl re-reads before posting.
- After a save the runtime may keep running the previously compiled chain until both
  cache-invalidation routes are called ([`../save/compiled-cache.ts`](../save/compiled-cache.ts)).
- The server's test-suite run is not observable per chain and does not evaluate
  assertions; see [`../test-cases/README.md`](../test-cases/README.md).
- History is addressed by category + method name through a published platform service
  whose uuid differs per env; `v1.ts` resolves and caches it per env.

## Adding a V2 read

1. Add the verb to `v2.ts`, returning a raw body or a `HydratedMethod` via `parseV2Method`.
2. Dispatch on the version in `index.ts`.
3. Spread `AD_V2_FLAG` in the command's args and document `--v2` in its `help.txt` and
   `desc.txt`.
4. Add a real fixture under `tests/fixtures/` and a test.

Up: [`../README.md`](../README.md)
