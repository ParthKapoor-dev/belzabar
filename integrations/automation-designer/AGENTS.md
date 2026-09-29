# AGENTS.md — Automation Designer

## Purpose

This directory contains the **AD command modules and lib** for the Automation Designer. It provides:

1. Namespaced `belz ad` commands for Automation Designer method workflows
2. Shared lib for API calls, parsing, hydration, payload building, caching

This directory is the `@belzabar/ad` workspace package. The unified `belz` binary is built from `apps/cli/`, which imports this package's `registry.ts`; there is no standalone entry point.

## Command Routing

```
belz ad <cmd>   → find, fetch, show, show-code, outputs, state, categories,
                  services, export, export-category, test-cases, test-report,
                  child-info, test, run, save-suite, run-suites, sql,
                  save, publish, create, delete, changelog, import,
                  category, test-case,
                  history, trace, validate, lint
```

`history` lists/shows/diffs/restores a method's saved versions. `trace`
locates a method on every environment relative to its dev version-history
"spine" (release promotion tracking) — see `lib/fingerprint.ts` for the
parser-agnostic structural fingerprint both share.

All commands accept `--v2` (universal flag, handled by
`lib/args/common.ts:resolveAdCommon`). When the selected operation does not
implement V2, the command prints a one-line fallback warning and runs V1.
The per-operation version defaults live in `lib/api-version.ts:DEFAULT_VERSION`
— to flip a default, edit one cell. See `docs/api-notes.md` for the long-form
rationale.

## Tech

1. Runtime: Bun + TypeScript
2. Commands registered in: `registry.ts` (static, sorted; exported as `@belzabar/ad/registry`)
3. Shared runner/framework: `@belzabar/core`

## Directory Map

1. `commands/` — one folder per AD command (`index.ts`, `help.txt`, `desc.txt`)
2. `lib/api-version.ts` — version enum, defaults, resolver
3. `lib/args/common.ts` — shared `defineArgs` flag fragments (`AD_COMMON_FLAGS` = `--v2`, `AD_YES_FLAG`, `AD_NOTE_FLAG`) + `resolveAdCommon` (V2→V1 fallback notice). Every command exports its spec as `args`; `apps/cli/tests/args-docs.test.ts` checks help.txt/desc.txt against it
4. `lib/args/confirm.ts` — interactive confirmation helper for write commands
5. `lib/types/common.ts` — unified in-memory types (`HydratedMethod`,
   `ParsedStep`, `MethodField`, …). **Commands import only from this file.**
6. `lib/types/v1-wire.ts`, `lib/types/v2-wire.ts` — raw wire types, parser/
   serializer/api-client only
7. `lib/parser/{index,v1,v2}.ts` + `lib/parser/steps/{shared,v1,v2}.ts` —
   discriminated step parsing (custom code, SpEL, SQL, Redis, existing).
   `lib/parser/steps/classify.ts` — **step classification by service
   identity** (AD-02): `ServiceIdentity {system, api, systemLabel?, apiUuid?,
   apiId?, sqlInputUuids?, inputLabels?}`, `classifyService()` (db_service |
   Database.SQL × data.read/add/update/delete/schema.modify → SQL;
   Helpers.Legacy/echo → SPEL_ECHO; Cache.Redis get/set/remove → REDIS_*),
   `resolveStepIdentity()` (injected resolver → V2 wire serviceName/methodName
   → verified per-env numeric/uuid fast path). Parsers take
   `ParseOptions {env?, resolveService?}`; without them unresolved steps stay
   EXISTING_SERVICE (never guessed). Numeric apiIds are env-local: never
   classify by them outside the per-env tables. V2 `orderIndex` is 1-based
   like V1; V2 uuid is the top-level `uuid`. V1 `updatedOn`/`updatedBy`.
7a. `lib/ids.ts` — `resolveMethodRef(input)` → trimmed lower-case 32-hex
   (accepts padded/dashed/upper-case uuids and AD URLs; else `INVALID_UUID`).
   **Every command taking a method uuid parses it with this.**
   `normalizeUuid()` trims server padding (never pad uuids).
7b. `lib/categories.ts` — one category identity (AD-09/10): `Category
   {chainCategoryId, chainCategoryUuid, systemId, systemUuid, name, type}`
   from `/chain/category?fetchSystemServices=false` (chain categories: what
   methods, POST /chain and export use; Test-Parth 1135) joined with `=true`
   (automation systems; Test-Parth 1318). `fetchCategories`, `findCategory`,
   `requireChainCategory` (name / id / uuid / system id → chain category).
8. `lib/api/{index,v1,v2}.ts` — unified `adApi` façade; V1 full, V2 fetch+test.
   `lib/api/changelog.ts` — change-note client (`/chain/changelog/{id}`,
   `/users/me`); surfaced via `adApi.addChangelog` / `adApi.listChangelog`
8a. `lib/stream-parser.ts` — parses `application/stream+json` execute responses
    (progressive chunks + final JSON envelope); used by `commands/run` `--stream`
9. `lib/serialize/v2.ts` — `planV2Overlay(live, overlay)`: the `ad save`
   overlay applied to the live V2 GET body (D1: saves go through
   `POST /chain/v2`; the V1 save route and serializer were removed). Writable:
   name, summary, description, parsedSteps[{orderIndex (1-based),
   source|sql|expression|description}]. Refused with AD_OVERLAY_NOT_APPLIED:
   buttonLabel, internalMethod, inputs[].testValue (the V2 route answers 200
   and drops them — live sems-dev), a field on a step of another kind, a
   missing step, an overlay that changes nothing. Unknown keys →
   AD_OVERLAY_UNKNOWN_KEY, bad types → AD_OVERLAY_INVALID, any change outside
   the target leaves → AD_SERIALIZER_DRIFT. Custom code keeps its stored
   encoding (sniffed with `decodeBase64Strict`), SQL its slot's `encodingType`.
   `lib/serialize/diff.ts` — `diffPaths`/`getAtPath`/`isUnder`/`jsonEqual`.
   **Structural ops (Stage 7.2)**: overlay key `ops[]` → `lib/serialize/ops.ts`
   `applyStructuralOps`: add-step / remove-step / move-step / update-step,
   set-/remove-input|variable|output. Step numbers are ALWAYS fetched positions
   (what `ad show` prints); placement `after: N` / `before: N` (`after: 0` =
   first, no anchor = append; several after one anchor keep op order). The
   plan then carries `structural {touched, order}`; L0 = every step not
   updated/removed and every field not set/removed is byte-identical.
   `lib/serialize/compact.ts` — the **compact step format** shared with
   `ad create --spec` (service / code / sql, inputs k=v with dotted nesting,
   outputs [key | {key, as, var, type, elementToRetrieve}] | {as: key}, when,
   exit, exitIf, loop {over|times|while|from/to}, account, async) and its
   expansion against callee contracts (`ServiceCatalog`: contracts + db
   accounts, loaded by `lib/save/services.ts` via the validator's
   `fetchContract`). Live facts it encodes (sems-dev 2026-09-29): a step has
   ONE exit code/message pair — the server mirrors it into `exitOnFailure` and
   `conditionalExit` — and the code is an integer; step output → variable is
   `inputReference {type:"method_input", reference}`; unknown input/output
   keys, unknown services and accounts are refused (the server drops/500s);
   custom-code outputs are bound by key (`as` ≠ key refused), several outputs
   get `elementToRetrieve`; new code is stored plain unless the text itself is
   base64, new SQL plain with encodingType NONE.
9a. `lib/save/` — the write pipeline. `pipeline.ts:saveOverlayV2` (draft
   guard on V2 → plan → `validation.ts:runValidationGate` → confirm →
   freshness re-GET (AD_VERSION_CONFLICT: the server ignores
   `metadata.version`, AD-08) → POST → `verifySaved` re-GET
   (AD_SAVE_VERIFY_FAILED; tolerates only `metadata.version` /
   `metadata.internal`, which every save rewrites, and `changelogs`, whose
   `entityVersion` follows the draft version and whose `user.lastLoginDate`
   moves on every login — also ignored by the freshness check) → compiled cache + local
   cache evicted, even when the POST/verify failed). `api.ts` —
   `postChainV2` (AD_SAVE_REJECTED with the server message), `deleteChainV2`.
   `compiled-cache.ts` — `invalidateCompiledCache(uuids)` POSTs
   `{uuids,type:"AUTOMATION"}` to BOTH `/rest/api/cache/invalidate` and
   `/rest/api/automations/cache/invalidate` (sems-dev needs both), never with
   an empty list, never throws. `flags.ts` — `--no-validate`, `--strict`,
   `--dry-run-compile` shared by save/publish/create.
   Structural saves verify with `verifyStructural(uuid, expected, after,
   touched)`: the re-read must equal the body sent except bookkeeping and,
   under `touched` (new/updated steps and fields; `""` = everything, used by
   `ad create`), server-filled fields (ids, uuids, types) and uuid padding.
   `--dry-run` (save and create) returns `{valid, validation{errors,
   warnings}}` as data (`dryRunValidation`) and writes nothing.
   `services.ts` — `loadServiceCatalog`, `servicesOfOps`,
   `servicesOfCompactSteps`. `sources.ts` — `codeFile`/`sqlFile` resolution
   (relative to the spec/overlay file) and `--sql-file`/`--code-file N=path`
   → update-step ops.
9b. `lib/sql/read-only.ts` — `ad sql run` / `explain` / TUI read mode accept one read
   statement only (comments + literals stripped first); `SQL_NOT_READ_ONLY`.
   EXPLAIN is judged by its inner statement (`splitExplain`): `EXPLAIN
   [ANALYZE] <read>` passes, `EXPLAIN ANALYZE DELETE …` does not (ANALYZE
   executes). `buildExplainSql` builds `ad sql explain`'s statement.
10. `lib/draft-guard.ts` — `resolveDraftTarget` — the **only** way to locate a
    safe save target. Fails closed: a method whose wire carries
    neither `automationState` nor `state` parses as `UNKNOWN` and is refused
    (`AD_DRAFT_GUARD_STATE_UNKNOWN`).
11. `lib/base64.ts`, `lib/xml.ts` — helpers used by the parsers and V2 test
12. `lib/hydrator.ts` (definition cache; `buildServiceResolver(raw)` looks up
    every V1 step's `/automations/{automationId}` once — `adApi.fetchMethod`
    uses it so every V1 read/write path sees classified steps;
    `identityFromDefinition`, `resolverFromTable` for offline/fixtures),
    `lib/cache.ts`, `lib/method-finder.ts`,
    `lib/input-collector.ts`, `lib/error-parser.ts`
12a. `lib/payload-builder.ts` — `buildV1TestPayload(raw, inputs)`: the ONE
    `/chain/test` body (`{category, jsonDefinition, id, uuid, version}`,
    testValues set, `automationApiId` filled from the definition for steps
    whose NUMERIC `automationId` lacks one — AD-16/38), `v1TestFormData`,
    `describeTestFailure` (server message for a failed test POST — F14).
    Used by `test`, `run-suites` and the SQL executor.
12b. `lib/history.ts` — `getVersionOf(method, category, N)`: history.get is
    addressed by category + name and `includeDraft:"true"` reads the DRAFT
    chain's version N, otherwise the PUBLISHED chain's; `listAll` lists by
    uuid. Draft and published keep independent version counters, so version
    N is read from the side the uuid names (F7). Used by `history` and `diff`.
12c. `lib/test-suite.ts` — `summarizeTestSuite`: the structured
    `{testSuiteId, testCases, total}` of `test-cases` and `test-case list` (F24).
12e. `lib/test-run.ts` — `runInlineTest(hydrated, values)`: one `/chain/test`
    run → `{status, outputs {code: value}, trace, failedStep, …}`;
    `diffOutputs`, `counterpart` (draft ↔ published via referenceId). Used by
    `ad test` (`--expect`, `--compare-published`).
12f. `lib/test-cases/` — test cases (7.7/7.13). `expect.ts`: `--expect`
    syntax (`out=v`, `!=`, `~=`, `>`/`<`/`>=`/`<=`, `out.path[0]=v`) +
    evaluation, and the assertion ↔ advance-mode SpEL mapping
    (`#{out} eq 'v'`, UI ops eq/neq/gt/lt/contains). `case-file.ts`: UI wire
    (`{"value": …}` wrapper text) ↔ case file `{name, description, inputs
    {fc: value}, inputExtras?, assertions[{output,op,expected}|{expression}]}`
    (stable key order, env-free), `diffCases`. `suite.ts`: `fetchSuite`,
    contract check vs the method's inputs/outputs, verified create/update
    (`checkPersisted` re-reads the suite), `planSync`/`applySync`. `files.ts`:
    export layout `<root>/<Category>/<method>/{method.json, cases/*.json}`
    (`method.json.uuids` = env → chain uuid). Live sems-dev facts: PUT
    persists inputs+assertions only (name/description/active ignored, even
    with the full body); DELETE is soft and never releases the name (400
    "TestCase name should be unique" → AD_TESTCASE_NAME_RESERVED); the bulk
    route wants `{fieldCode: string}` inputs (400 on UI bodies), so `bulk`
    posts one case at a time; `active:false` cases vanish from the suite
    GET; jsonb values read back re-spaced (compare decoded). The V2 GET body
    embeds `testSuite`, and every V2 save rewrites its test-case input ids /
    timestamps.
12d. `lib/fingerprint.ts` — `fingerprintMethod` (12-hex logic hash, used by
    `state`, `publish`, `history restore`, `trace`) and `methodDiffView` /
    `diffPaths` (the semantic view `diff` compares: decoded code/SQL/SpEL,
    services, conditions, mappings, contract; no env-local ids).
13. `lib/sql/*` — SQL executor + TUI. Default DB when `--db` is absent
    (AD-36): `environments.<env>.sqlDefaultDb` in `~/.belz/config.json` →
    `BELZ_SQL_DEFAULT_DB` → `NSM_Read_DB` (NSM only); `selectedBy` says which.
    `insert` with `RETURNING <col>` asks for the operation's generatedId output
    (F25); a multi-row RETURNING makes the platform fail AFTER committing and
    list the keys in its error — belz parses them (`generatedKeys`).
14. `tests/unit/` — save-structural (ops placement/refusals/encodings/
    compact expansion, verifyStructural), author-commands (save ops +
    --sql-file/--code-file/--dry-run and create --spec compact via fakeFetch),
    save-v2-overlay (round-trip + per-field overlay table
    over the 36 real V2 bodies, every refusal code), save-command (V2 pipeline
    via fakeFetch: freshness conflict, verify failure, cache routes, validator
    gate), sql-read-only, parser, serializer, version resolver, draft guard, xml,
    base64, error detection, sql, note-flag, stream-parser tests;
    `real-wire.test.ts` — V1↔V2 parse parity over the 36 real methods
    (step kinds, SQL text, service names, uuid, 1-based orderIndex),
    definition identity == V2 wire identity, category sources,
    200-empty-body not-found
15. Fixtures. Real sems-dev wire, sanitized, each dir has a `manifest.json`
    (source id, env, capturedAt, endpoint); captured/refreshed with
    `bun scripts/fixtures/capture.ts <target>` (repo root, read-only, sems-dev only):
    `real-v1/` (36 V1 bodies), `real-v2/` (same 36, V2), `definitions/`
    (`/automations/{automationId}` for 10 of them), `categories/`
    (`/chain/category`, `/automation/services`), `not-found/`,
    `child-info/` (full automation-API contracts + a slimmed `/auth` list),
    `callers/` (the "Example services" V1 method listing + V2 bodies of its
    methods). One-off GETs: `capture.ts ad-raw <subdir> <file> <endpoint>`.
    `tests/fixtures/v1/step-*.json` are hand-written single-step fixtures
    (numeric `automationId`, like the wire). Prefer real fixtures for new tests.
15a. `lib/compact.ts` — `pruneEmpty`, `abbreviate`/`oneLine`, and the
    `--fields a,b|all` convention (`parseFieldList` + `projectRow`, same as
    `pd show --fields`) used by the trimmed read commands (Stage 7.9).
    `lib/method-view.ts` — `compactMethod`/`compactStepLine`/`renderCompact`
    (`show --compact`), `storyMarkdown` (`show --story`), `stepFacts` (loop /
    exit read from the step wire: V2 `repeatStepExecution.{type,value,counter}`,
    `exitCondition`), `flattenStepInputs`/`identityForStep` (moved from show).
16. `docs/api-notes.md` — belz-owned cheatsheet (read this before touching
    lib/api/*, lib/parser/*, or lib/draft-guard.ts)
17. `lib/validate/` — the pre-save validator (Stage 5, A4) over the **V2 wire
    body**. API (`index.ts`): `validateMethodV2({after, before?, overlayPaths?,
    strict?})` (L1–L3, offline, pure) and `validateOnline({…, env,
    dryRunCompile?})` (+L4) → `{errors, warnings, layersRun}`. Layers:
    `schema.ts` L1 (zod types/enums + key regexes), `steps.ts` L2 (custom code
    incl. compile-only JS parse, SQL, SpEL, conditions, loops, encodings),
    `graph.ts` L3 (#{root} def-before-use, SV1/M3/DUP1/S3/AS1, outputRef, dead
    steps), `online.ts` L4 (callee contract via
    `GET /automation-systems/{svc}/automation-apis/{uri}` — db_service uses the
    uri: data.read→select…; accounts via `/automation-systems/{svc}/auth`; both
    cached 1 h in `~/.belz/cache/{api-contracts,service-accounts}/<env>/`;
    dry-run compile = the V2 body converted to a V1 inline-test payload with
    every step gated `#{'belz' eq 'dry-run'}`, loops/async stripped, POSTed to
    `/chain/test` — live-verified: nothing executes, bad bindings give
    "Error while compiling automation"). `catalogue.ts` = every rule code
    (team validate.py codes M1, CI1, LP3… keep their meaning; belz rules are
    `AD-<FAMILY>-nnn`) with severity/layer/description. `spel.ts` = `#{…}`
    scanner + root extraction. **Diff-aware**: a finding whose fingerprint
    (rule + path, `steps[i]` keyed by step id) is also in `before` becomes a
    `preexisting` warning; `strict` promotes only new warnings. Calibration
    (tests/unit/validate-diff.test.ts): the 36 real bodies validated against
    themselves give 0 errors; raw counts are pinned there. Fixtures:
    `tests/fixtures/validate/` (research golden + live case patches with the
    observed server result; `online/` slim contract captures). Adding a rule:
    add it to `catalogue.ts`, emit it with `report({rule, message, path, step})`,
    add a positive + negative row in validate-l1/-rules/-online tests.
    `lint.ts` = the advisory review rules of `ad lint` (own `LINT_RULES`
    catalogue, always `warn`; not run by save/publish).

### Adding new commands

After creating a `commands/<name>/index.ts` with `help.txt` and `desc.txt`,
add the command to `registry.ts` (keep it sorted). `apps/cli/tests/registry.test.ts`
fails if a folder is missing from the registry.

## Commands

### Read (`belz ad <cmd>`)

1. `fetch` — raw V1 or V2 fetch + cache
2. `find` — search and pick methods (cached index). Compact rows (7.9:
   name, alias, category, state, uuid, referenceId, apiUuid, summary, score;
   `--fields a,b|all`), `--category <prefix>`, and `--describe <words>` (7.5:
   word search over name/alias/summary/description/category,
   `lib/method-finder.ts:describeSearch`). The index (schema 2,
   `METHOD_FINDER_SCHEMA`) keeps per method `automationApiUuid`, `summary`,
   `description` (≤400 chars), `calls` (`u:<apiUuid>` / `n:<numericApiId>` from
   the listing's V1 jsonDefinition) and `opaqueSteps` (automationId-only steps);
   describe/callers rebuild a schema-1 cache, plain find keeps using it.
3. `show <uuid|url|file>` — rich display with `[CODE]` / `[SPEL]` / `[SQL]` / `[REDIS-*]`
   badges, `--code`, `--sql`, `--outputs`, `--variables`, `--service-detail <N>` (alias `--step <N>`, orderIndex) flags.
   Step `identity` is a string when present (`service.method`, `apiId:N`, `automationId:N`);
   step details include input values (`inputs[]`) and basic condition rows.
   Stage 7.1: the `--llm` payload is lean (no `request` echo, no `badge`,
   empty/null fields pruned, SQL/code bodies only with `--sql`/`--code`/`--full`/
   `--service-detail`, `--raw` = the wire body once as `data.raw`).
   `--compact` = `{view:"compact", …, steps: string[], blocks?}` (one line per
   step, `lib/method-view.ts`), `--story` = `{view:"story", markdown}` (the AD
   skill's pre-save approval template). A local V2/V1 JSON file is shown
   without a fetch (`source:"file"`).
4. `show-code` — dump decoded custom-code source for all / a single step
5. `outputs` — inputs/variables/outputs contract only (agent-friendly)
6. `state` — draft/published linkage, `versions`, and `inSync` = logic
   fingerprints of draft and published are equal (AD-18: the two version
   counters are independent, never compare them). One fetch per side (the
   guard returns `initial`).
7. `categories` — list AD categories (`id` = chain-category id, plus systemId/systemUuid); filter by `--user` / `--system`
8. `services` — list platform services (`--internal`, `--limit`, `--fields a,b|all`);
   compact rows by default. `--search <q>` fuzzy-ranks (method-finder scorer,
   `scoreFuzzy`) over name/label/aliases/description, adds `score`, top 20.
9. `export` — export a single method as JSON (numeric chain id or any uuid spelling)
10. `export-category` — export every method in a category (name, id or uuid → chain-category id)
11. `test-cases` — list persistent test cases on a method
12. `test-report` — latest test-suite execution report
13. `child-info` — resolve a child method's inputs/outputs by name (unknown/draft-only → METHOD_NOT_FOUND).
    `--shape` (7.5, `lib/api-shape.ts`): one line per input (V2 step key path =
    `produces`, type, required, BASE_64, enum values from DROPDOWN sources,
    default, UI label), output keys (`consumes`), apiUuid / numeric apiId /
    methodUuid, and accounts from `/automation-systems/{svc}/auth` as
    `id nickname (scope)` — never field values. `--all` adds UI-hidden inputs.
14. `test` — V1 test-before-save with rich per-step trace (rows joined to the
    method's steps: real description + orderIndex) and `outputs {code:
    value}`. `--expect out=v` (repeatable) → `expectations {total, passed,
    failed, results}`, any failure = AD_TEST_EXPECTATION_FAILED (exit 1);
    `--case <file>` takes inputs + assertions from a case file;
    `--compare-published` also runs the counterpart (draft ↔ published) with
    the same inputs → `compare {identical, differences[], published{status,
    outputs, expectations?}}` (the draft run decides the exit code). **Declares
    `writes`**: it really runs the chain (SQL commits).
15. `run` — live-execute a published method (`--stream` opts into a streaming
    method: `application/stream+json` chunks + final JSON envelope; no
    timeout). **Declares `writes`.** A DRAFT uuid runs its PUBLISHED body —
    belz warns and reports `inputState` / `executesPublishedUuid` (AD-34).
16. `save-suite`, `run-suites` — local `.spec.json` suites (V1); run-suites
    **declares `writes`** and posts the same body as `test`.
17. `sql` — SQL run/explain/dbs/update/insert/modify/tui (`tui` declares `writes`:
    it can switch to write modes). `explain "<read>" [--analyze [--buffers]]
    [--format text|json]` (7.11) → `plan` (lines or parsed JSON) + `timing
    {planningMs, executionMs}`; a read, gated like run.
18. `changelog <uuid>` — list the notes of the chain the uuid names;
    `--note "<text>"` is a write: draft-guarded (recorded on the DRAFT chain,
    as publish does), confirmation / `--yes`
19b. `lint <uuid|file>` (7.4) — read-only review: the validator (L1–L3,
    `--online` L4) + `lib/validate/lint.ts` advisory rules (Q2 SELECT-list
    subquery, Q3 raw feature_config/feature_status read, Q4 re-lookup of a
    bound :param, AD-LINT-001…010: JSON-juggling custom code, SQL without a
    table, SQL built by replacePlaceholdersInText, key `language`, >30 steps,
    echo read/write race, `+` on numeric inputs, BASE_64 variable, FLOAT
    default digits, descriptions with `--docs`). Grouped by step (`groups
    [{scope, findings}]`, `byRule`); errors → AD_LINT_FAILED; `--strict`.
    Lint rules are warnings (calibrated on the 36 real bodies:
    tests/unit/lint.test.ts pins the counts).
19a. `validate <uuid|file>` — lib/validate over a fetched V2 body or a local
    V2 file; `--online` (L4 service contract), `--dry-run-compile` (implies
    `--online`, declares `writes` → explicit `--env`), `--strict`. Errors →
    `AD_VALIDATION_FAILED` (data = result). A PUBLISHED uuid is audited without
    AD-META-001.
19. `history list|show|diff <uuid>` — the history of the chain the uuid
    names (`side` in the data); `trace <uuid>` — spine = active env (or
    `--spine`), envs = the spine's project family (or `--envs a,b`), a
    draft uuid is traced via its published chain (AD-25); `diff` — history
    or cross-env (in-process, AD-26), reports `changed` + `differences`

### Write (`belz ad <cmd>`) — all draft-guarded

1. `save [file] --uuid <draftUuid>` — save a JSON overlay onto a draft (V2 route; see 9/9a):
   leaf edits, structural `ops[]`, `--sql-file`/`--code-file N=path`
   (repeatable; file optional then), `--dry-run` (not a write: no --env needed)
2. `publish <uuid> --note "<text>"` — promote a draft to its published version.
   `--note` is mandatory: belz publishes FIRST, then records the note on the
   draft chain (3 attempts); a note that still fails keeps the publish and
   reports `noteRecorded:false` + a warning (AD-19). `changelogId` is looked
   up in the list (the POST answers `{"success":true}` without an id).
   Before anything is written the draft's V2 body is validated
   (lib/save/validation.ts; `--no-validate`, `--strict`, `--dry-run-compile`).
   Findings also present in the current published copy are pre-existing and
   still block unless `--allow-preexisting`. After the publish the compiled
   cache of draft + published is evicted on both routes (`compiledCache`).
2a. `create --spec <file> [--category <name|id|uuid>]` — new DRAFT via
   `POST /chain/v2` (no uuid). Spec = compact (serialize/compact.ts; steps by
   service/code/sql, `category` may be in the spec — must agree with the flag)
   or a V2 body/subset (lib/save/create.ts: `buildCreateBody` fills UI
   defaults, drops server-owned keys and method-level uuids/step ids; raw and
   compact steps can mix). `assertCreatableCategory` refuses Helpers.*/
   Database.*/Cache.*/Email.*/Expertly.*/Web Socket/system services (WSR-6,
   AD_CATEGORY_PROTECTED). Validated like save; duplicate name →
   AD_METHOD_EXISTS; verified on re-read (DRAFT, name, category, step count,
   then `verifyStructural` over the whole body). `--dry-run` prints the
   expanded body + validation, creates nothing (not a write).
2b. `delete <uuid>` — soft delete (`DELETE /chain/v2/{uuid}`) of a DRAFT that
   was never published only (AD_DELETE_PUBLISHED / AD_DELETE_HAS_PUBLISHED /
   fail closed on a missing state). Verified when the V2 re-read answers
   METHOD_NOT_FOUND — V1 keeps returning deleted records and its
   `active`/`deprecatedAt` fields do NOT mark deletion.
3. `import <file>` — POST `/chain/import`
4. `category create <name>` — create a new AD category/service
5. `test-case <action>` — `list | create | update | delete | bulk |
   run-suite | delete-suite | export | sync`. create (`--file` case file / UI
   body, or `--name --input k=v --assert out=v`), update and bulk are
   contract-checked (AD_TESTCASE_CONTRACT), refuse a taken name
   (AD_TESTCASE_EXISTS) and are verified by re-reading the suite
   (AD_TESTCASE_VERIFY_FAILED). update refuses name/description changes
   (AD_TESTCASE_FIELD_NOT_UPDATABLE). `export <uuid> --dir <root>` (read-only)
   writes the git-friendly files; `sync <methodDir>` is a dry-run plan
   (create/update/drift/extra/conflict) unless `--apply` (a write; `--prune`
   deletes server-only cases); applied syncs are verified.
6. `sql update|insert|modify` — SQL writes; confirmation or `--yes` like
   every other AD write.
7. `history restore <draftUuid> --version N` — draft-guarded; a published
   uuid is refused (`HISTORY_RESTORE_NEEDS_DRAFT`, versions are per chain);
   the target version must exist; fails closed on an unrecognised answer
   unless the re-fetched draft matches (`RESTORE_UNCONFIRMED`); reports
   `resultingVersion` / `contentMatches` (AD-23).
8. `changelog <uuid> --note` (see above).

Also `writes` (explicit `--env`, D6) without a draft guard, because they
execute rather than save: `test`, `run`, `run-suites`, `sql tui`.
Long server operations (`/chain/test`, execute, publish, test suites,
history restore) pass a 10 min per-call timeout (`AD_LONG_OP_TIMEOUT_MS`).

**Every write command MUST route through `lib/draft-guard.ts:resolveDraftTarget`
before saving.** Never POST a save payload whose UUID resolves to PUBLISHED —
the server will silently overwrite production. Interactive confirm is required
unless `--yes` is passed; in `--llm` mode, `--yes` is mandatory.

## Core Behavior Contract

1. Use `CommandModule` from `@belzabar/core`.
2. `parseArgs` validates/parses input only.
3. `execute` contains business logic and returns `ok(...)`/`fail(...)` or throws `CliError`.
4. `presentHuman` is optional and only for human-friendly rendering.
5. Command modules must not call `process.exit` or print ad-hoc output for machine mode.
6. `find` supports `list` (category counts), query search, and `pick` (interactive `fzf` method picker; needs a TTY, else INTERACTIVE_NOT_SUPPORTED), plus `--open` to open the selected method URL after pick. `--refresh` reports progress on stderr; `--raw` is capped at `--limit`; flags may precede the subcommand (`find --refresh list`).

## Output Contract

1. Human mode: tables/sections/objects rendered by presenter or default renderer.
2. `--llm` mode: single JSON envelope:
   - `schema`
   - `version`
   - `ok`
   - `command`
   - `data`
   - `error`
   - `meta`
3. `--raw` is command-specific and must be explicit.

## Runtime Data and Caching

All runtime state lives under `~/.belz/`:

1. Auth sessions: `~/.belz/sessions/<env>.json`
2. Method cache: `~/.belz/cache/methods/<env>/<uuid>.json` (soft TTL 5 min, hard 1 h; key = trimmed lower-case uuid; invalidated by `ad save` (lib/save), `adApi.publishDraft` and `history restore`)
3. Method finder index cache: `~/.belz/cache/method-finder/index-v1-<env>.json` (TTL 7 days; `schemaVersion` inside, see `find`)
4. Service definition cache: `~/.belz/cache/definitions/<env>/<automationId>.json` (TTL 1 h)
4a. Validator L4 caches: `~/.belz/cache/api-contracts/<env>/<service>__<method>.json`, `~/.belz/cache/service-accounts/<env>/<service>.json` (TTL 1 h)
5. Local test suites: `./suites/*.spec.json`

## `~/.belz/config.json`

Optional credential config file. Loaded at startup; **config file wins** over env vars.

```json
{
  "environments": {
    "nsm-dev":  { "url": "...", "user": "...", "password": "<base64>" },
    "nsm-qa":   { "url": "...", "user": "...", "password": "<base64>" },
    "nsm-uat":  { "url": "...", "user": "...", "password": "<base64>" }
  }
}
```

All fields per-env are optional — missing ones fall back to env vars (`NSM_DEV_USER`, etc.).
`password` is base64-encoded (decoded via `atob()` in `Config.password`).

## Command Registry

`registry.ts` maps each command name to `{ module, help, desc }` (help/desc imported as text,
so the compiled binary embeds them). `apps/cli/bin/options.ts` wires it into `belz ad`.
`lib/trace.ts` (`traceMethod`) is also used by `@belzabar/release`.

## Important Files for Agents

1. API wrappers: `lib/api.ts`
2. Method finder index/search logic: `lib/method-finder.ts`
3. Method parser: `lib/parser.ts`
4. Find command entrypoint: `commands/find/index.ts`
5. Show command deep inspection: `commands/show/index.ts`
6. Test payload: `lib/payload-builder.ts:buildV1TestPayload`
7. Trace error interpretation: `lib/error-parser.ts`
8. Changelog client: `lib/api/changelog.ts`
9. SQL command entrypoint: `commands/sql/index.ts`
10. SQL helper modules: `lib/sql/`
11. SQL TUI session: `lib/sql/tui/session.ts`
12. Method tracing across envs: `lib/trace.ts` (used by `ad trace` and `release matrix`)

## Known Current Gaps

1. `test` has only a V1 path (`--v2` falls back with a notice); `--force` is a hidden,
   deprecated no-op (warns) so old scripts keep working (AD-15).
2. `save-suite` writes to `suites/` path and assumes directory availability.

## desc.txt Standard

Every command must have a `desc.txt` alongside its `help.txt`.
Format: one line per invocation variant, covering the base call and every meaningful flag/subcommand:

```
belz ad <cmd> <args>  :->  What the base call does
belz ad <cmd> <args> --flag  :->  What this flag adds
belz ad <cmd> <args> --flag <value>  :->  What this flag+value does
```

This file feeds `belz --help-full` — the canonical per-command reference for agents and LLMs.
Update it whenever you add, remove, or change any flag or subcommand.

## Help Text Standard

Every command must have a `help.txt` following this exact template:

```
Usage: belz <ns> <cmd> <REQUIRED_ARG> [OPTIONAL_ARG] [flags]

One-sentence description of what the command does.

Arguments:
  <REQUIRED_ARG>        Description.
  [OPTIONAL_ARG]        Description. Defaults to X if omitted.

Flags:
  --flag-name <VALUE>   Description. (default: X)
  --bool-flag           Description.
  --help, -h            Show this help message.

Global Flags:
  --env <name>          Set active environment. (default: nsm-dev)
                        Available: nsm-dev | nsm-qa | nsm-uat
  --llm                 Output structured JSON envelope for scripting/LLM use.

Examples:
  belz <ns> <cmd> <example1>
  belz <ns> <cmd> <example2> --flag
  belz <ns> <cmd> <example3> --flag --llm
```

Rules:
1. Prefix: `belz ad` for AD commands · `belz pd` for PD commands · `belz` for top-level
2. Required positionals: UPPERCASE in `<>` — `<UUID>`, `<FILE>`, `<NAME>`
3. Optional positionals: in `[]` — `[PAYLOAD]`, `[PAGE_ID]`
4. Column alignment: flag descriptions start at column 24
5. Required flags: end description with `(required)`
6. Defaults: end description with `(default: X)`
7. `--help, -h` is always the last Flags entry, before Global Flags
8. Always include the **Global Flags** section
9. Always use plural **Examples:** with 2–3 real examples
10. Blank line between every section

## Safe Change Checklist

1. If adding/removing AD commands, update `registry.ts` (sorted) in the same commit.
2. Keep `help.txt` and command docs aligned with actual flags.
3. When adding a command, include both a `help.txt` and a `desc.txt` following the standards above.
4. When changing flags or subcommands, update `desc.txt` to match — this keeps `belz --help-full` accurate.
5. Preserve envelope schema stability for `--llm` consumers and MCP tools.
6. Validate auth mode (`Bearer` vs `Raw`) for each endpoint before changing requests.

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this module — new or removed
commands, changed API behavior, new lib files, output schema changes, or structural
reorganization — update this `AGENTS.md` and `registry.ts` in the same commit.
