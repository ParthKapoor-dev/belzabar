# Automation Designer — belz-cli API Notes

This is belz's own cheatsheet for how the CLI talks to Automation Designer. For
the exhaustive server API reference see the Expertly platform documentation. This file
is the short version — what belz assumes, which code path owns which verb, and
where the footguns live.

---

## TL;DR

- **V1 is the default** for reads, test and publish. `fetch`, `show` and
  `show-code` take `--v2` to read the method through the V2 API instead.
  `save`, `create` and `delete` always use V2 (`/chain/v2`); belz has no V1
  save route. Every other command talks to the one route it needs.
- All parser output is a single shape (`HydratedMethod` / `ParsedStep` in
  `lib/types/common.ts`). Commands never see raw wire types.
- All write paths pass through `resolveDraftTarget` in `lib/draft-guard.ts`.
  We never save directly to a `PUBLISHED` method.

## Where things live

| Concern | File |
|---|---|
| `--v2` flag and `apiVersionOf` | `lib/args/common.ts` |
| In-memory types (what commands see) | `lib/types/common.ts` |
| V1 raw wire shapes | `lib/types/v1-wire.ts` |
| V2 raw wire shapes | `lib/types/v2-wire.ts` |
| Parser entry points (`parseV1Method`, `parseV2Method`) | `lib/parser/index.ts` |
| V1 method parser | `lib/parser/v1.ts` |
| V2 method parser | `lib/parser/v2.ts` |
| V1 step parser | `lib/parser/steps/v1.ts` |
| V2 step parser | `lib/parser/steps/v2.ts` |
| Shared step helpers / constants | `lib/parser/steps/shared.ts` |
| API façade (`adApi`) | `lib/api/index.ts` |
| V1 endpoint wrappers | `lib/api/v1.ts` |
| V2 raw GET (`fetchRawMethod`) | `lib/api/v2.ts` |
| Save overlay → V2 body | `lib/serialize/v2.ts` (+ `diff.ts`) |
| Save / create / delete pipeline | `lib/save/` |
| Draft-safety guard | `lib/draft-guard.ts` |
| base64 helper | `lib/base64.ts` |

## Version selection

`ApiVersion` (`"v1" | "v2"`) lives in `lib/types/common.ts`. Only the commands
that read a method definition (`fetch`, `show`, `show-code`) spread
`AD_V2_FLAG` and pass `apiVersionOf(flags)` to `adApi.fetchMethod`. Every other
command calls the wire module for its route directly.

### Adding V2 support to another read

1. Add a verb to `lib/api/v2.ts` that hits the V2 endpoint and returns either a
   `HydratedMethod` (via `parseV2Method`) or a typed response.
2. Update `lib/api/index.ts:adApi.<verb>` to dispatch by version.
3. Spread `AD_V2_FLAG` in the command's args and document `--v2` in its
   help.txt and desc.txt.
4. Commit a smoke fixture under `tests/fixtures/v2/` and a smoke test.

## V1 vs V2 — what actually differs (quick reference)

|  | V1 | V2 |
|---|---|---|
| Fetch | `GET /rest/api/automation/chain/{uuid}` | `GET /rest/api/automation/chain/v2/{uuid}?basicInfo=false` |
| Method JSON | `jsonDefinition` is a **stringified** JSON blob | Flat JSON at the top level |
| Step discriminator | `activeTab.id` + numeric `automationApiId` (env-specific) | `properties.type` + UUID `automationAPIId` (portable) |
| Custom code body | Base64 in `code` | Inline in `properties.customCode.inlineCode` |
| State field | `automationState` at top level | `metadata.state` |
| Save | `POST /rest/api/automation/chain` with stringified `jsonDefinition` | `POST /rest/api/automation/chain/v2` flat |
| Test | `POST /rest/api/automation/chain/test` — multipart `body=<compact JSON>`, JSON response, **test-before-save supported** | `POST /rest/api/automation/chain/test/execute/{uuid}` — per-input `-F` fields, XML response, **must be saved first** |
| Publish | Shared: `POST /rest/api/automation/chain/{uuid}/publish` | Same |
| Export / import / categories / services | Shared — no V1/V2 split | — |
| Test case update | `PUT /testcases/{chainId}/{testCaseId}` | Not supported — delete + recreate |

belz's **default choice is V1** for almost everything because V1 supports test-
before-save (the developer loop) and returns a rich per-step trace. V2 is
better when you need to see the saved method exactly as the V2 wire holds it.

## Parser rules (the thing belz used to get wrong)

`lib/parser/steps/v1.ts` discriminates V1 steps via:

- `activeTab.id === "customCode"` → `CUSTOM_CODE`
- `activeTab.id === "existingService"` plus `automationApiId`:
  - `21927` (`Helpers.Legacy.echo`) → `SPEL_ECHO`
  - `48 / 49 / 893 / 894 / 50` (`Database.SQL` data.read/update/add/delete/schema.modify) → `SQL`
  - `22929 / 22930 / 22928` (`Cache.Redis` get/set/remove) → `REDIS_GET` / `REDIS_SET` / `REDIS_REMOVE`
  - else → `EXISTING_SERVICE`
- missing `activeTab` → `UNKNOWN` with `reason`

Base64 decoding:

- Custom code: `raw.code` is base64 — decoded into `step.source`, `sourceEncoding = "BASE_64"`.
- SQL: the inner mapping whose `encodingType === "BASE_64"` is decoded into `step.sql`, `sqlEncoding = "BASE_64"`.

**Every parsed step preserves the original wire JSON in `step.raw`.** Saves
(`lib/serialize/v2.ts`) never re-serialize steps: they overlay the target
leaves onto the live V2 GET body, so every other byte is sent back verbatim.

## Draft-safety invariant

`lib/draft-guard.ts:resolveDraftTarget(uuid, version)` is the **only** way a
write command locates its save target. Given any UUID it returns a structured
result:

- `{ok: true, draft, publishedUuid, switchedFromPublished: false}` — input was
  already a draft. May or may not be linked to a published version.
- `{ok: true, draft, publishedUuid, switchedFromPublished: true}` — input was
  PUBLISHED; we fetched its linked draft via `referenceId` and switched to it.
- `{ok: false, reason: "PUBLISHED_NO_DRAFT", ...}` — input was PUBLISHED and
  has no linked draft. Caller must tell the user to create a draft in the UI.
- `{ok: false, reason: "REFERENCE_NOT_DRAFT", ...}` — defensive. Should never
  happen per API semantics but is handled.

No write path bypasses this. If you are adding a write command and your first
instinct is to POST `/chain/v2` directly with the user-provided UUID, stop and
go through `lib/save/pipeline.ts` (which calls `resolveDraftTarget` first).

## Known gotchas

1. **Saves use V2 (D1).** `POST /chain/v2` with the live GET body plus the
   overlay; a thin body gets `400 Invalid state`. The server ignores
   `metadata.version` (no optimistic locking) — belz re-GETs before POSTing.
   A no-op save rewrites only `metadata.version.name` and
   `metadata.internal.migrationVersion`. `buttonLabel`, `internalMethod` and
   input `testValue`s are accepted and dropped.
2. **Compiled-chain cache.** After a save the runtime may keep executing the
   old body until BOTH `/rest/api/cache/invalidate` and
   `/rest/api/automations/cache/invalidate` are called (verified live).
3. **Custom-code multi-output rule.** Every output on a `CUSTOM_CODE` step
   (beyond the first) must have `elementToRetrieve` set — a `lib/validate`
   rule now.
4. **V2 test does not evaluate assertions.** `runTestSuite` returns
   `executionStatus: "PASS"` when the method ran without errors, not when
   assertions pass. Commands that surface suite results must say so.
5. **Test cases are immutable on V2, updatable on V1.** belz uses V1, so the
   test-case `update` subcommand is a full-fidelity feature. If we ever flip
   test-case to V2 the subcommand must warn and fall back to delete+recreate.
6. **The `raw` field on every parsed step is load-bearing.** Never drop it,
   never deep-clone it in ways that strip unknown fields. The serializer uses
   it to round-trip unknown step kinds verbatim.
