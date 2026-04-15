# Automation Designer — belz-cli API Notes

This is belz's own cheatsheet for how the CLI talks to Automation Designer. For
the exhaustive server API reference see the expertly docs under
`expertly.coding.agents/Claude/docs-projects/Expertly/Automation_Designer/` and
`expertly.coding.agents/Claude/Common/claude/skills/ad/reference/`. This file
is the short version — what belz assumes, which code path owns which verb, and
where the footguns live.

---

## TL;DR

- **V1 is the default** for every operation. V2 is opt-in via `--v2`.
- Every AD command accepts `--v2`. When the selected operation does not
  implement V2 the CLI prints a one-line fallback warning and runs V1.
- All parser output is a single shape (`HydratedMethod` / `ParsedStep` in
  `lib/types/common.ts`). Commands never see raw wire types.
- All write paths pass through `resolveDraftTarget` in `lib/draft-guard.ts`.
  We never save directly to a `PUBLISHED` method.

## Where things live

| Concern | File |
|---|---|
| Version enum, defaults, resolver | `lib/api-version.ts` |
| Shared `--v2` / `--env` flag parser | `lib/args/common.ts` |
| In-memory types (what commands see) | `lib/types/common.ts` |
| V1 raw wire shapes | `lib/types/v1-wire.ts` |
| V2 raw wire shapes | `lib/types/v2-wire.ts` |
| Parser façade (`parseMethod`) | `lib/parser/index.ts` |
| V1 method parser | `lib/parser/v1.ts` |
| V2 method parser | `lib/parser/v2.ts` |
| V1 step parser | `lib/parser/steps/v1.ts` |
| V2 step parser | `lib/parser/steps/v2.ts` |
| Shared step helpers / constants | `lib/parser/steps/shared.ts` |
| API façade (`adApi`) | `lib/api/index.ts` |
| V1 endpoint wrappers | `lib/api/v1.ts` |
| V2 endpoint wrappers (fetch + test only) | `lib/api/v2.ts` |
| V1 save payload serializer | `lib/serialize/v1.ts` |
| Draft-safety guard | `lib/draft-guard.ts` |
| base64 helper | `lib/base64.ts` |
| Tiny XML HashMap reader (V2 test response) | `lib/xml.ts` |

## Version resolution

Every operation is a member of `AdOperation` (fetch, list, save, publish, test,
run, export, import, testCase, category, childInfo). Two tables live in
`lib/api-version.ts`:

- `DEFAULT_VERSION[op]` — the version used when the caller does not pass `--v2`.
  **To flip the default for an op, change one cell here.**
- `SUPPORTED_VERSIONS[op]` — which versions belz actually implements for that op.
  If the user passes `--v2` for an op that is V1-only, `resolveApiVersion` warns
  and returns `{version: "v1", wasFallback: true, requested: "v2"}`.

`lib/args/common.ts:parseAdCommonArgs(argv, op, cmdName)` strips `--v2` from
argv and returns a resolved version. Every AD command calls this once at the
top of `parseArgs()`. Commands never read the flag directly and never touch
`DEFAULT_VERSION` — they take the resolved version.

### Adding V2 support to a new operation

1. Add `"v2"` to `SUPPORTED_VERSIONS[op]` in `lib/api-version.ts`.
2. Add a verb to `lib/api/v2.ts` that hits the V2 endpoint and returns either a
   `HydratedMethod` (via `parseV2Method`) or a typed response.
3. Update `lib/api/index.ts:adApi.<verb>` to dispatch by version.
4. Commit a smoke fixture under `tests/fixtures/v2/` and a smoke test.
5. Optionally flip `DEFAULT_VERSION[op]` to `"v2"` once the V2 path is battle-
   tested.

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
better when you need to verify the saved, live method runs under the real wire
format — that is why `test --v2` exists as an opt-in.

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

**Every parsed step preserves the original wire JSON in `step.raw`.** The
serializer (`lib/serialize/v1.ts`) prefers round-tripping `raw` when the step
was not edited, so partially-understood and `UNKNOWN` steps save back verbatim.

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
instinct is to call `adApi.saveMethod` directly with the user-provided UUID,
stop and call `resolveDraftTarget` first.

## Known gotchas

1. **V1 double-serialization.** `jsonDefinition` is a string inside the save
   payload. `lib/serialize/v1.ts` handles it — callers never stringify by hand.
2. **V1 save assigns `automationId`s server-side.** Every write command must
   `adApi.fetchMethod(uuid, version)` after saving, or subsequent SpEL/existing-
   service tests will fail.
3. **Custom-code multi-output rule.** Every output on a `CUSTOM_CODE` step
   (beyond the first) must have `elementToRetrieve` set. `serialize/v1.ts`
   refuses to emit a payload that violates this.
4. **V2 test does not evaluate assertions.** `runTestSuite` returns
   `executionStatus: "PASS"` when the method ran without errors, not when
   assertions pass. Commands that surface suite results must say so.
5. **Test cases are immutable on V2, updatable on V1.** belz uses V1, so the
   test-case `update` subcommand is a full-fidelity feature. If we ever flip
   test-case to V2 the subcommand must warn and fall back to delete+recreate.
6. **The `raw` field on every parsed step is load-bearing.** Never drop it,
   never deep-clone it in ways that strip unknown fields. The serializer uses
   it to round-trip unknown step kinds verbatim.
