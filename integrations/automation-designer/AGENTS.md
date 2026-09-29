# AGENTS.md — Automation Designer (`@belzabar/ad`)

The `belz ad` commands and the AD library. Automation Designer (AD) keeps backend logic
as versioned **methods** ("chains") of steps. Every method has a DRAFT chain and, once
published, a PUBLISHED chain. The two have separate uuids and independent version
counters. This workspace has no entry point of its own: `apps/cli` imports
`registry.ts`. Other workspaces import `@belzabar/ad/lib/*`. For example, `release`
uses `lib/trace.ts`.

Read `docs/api-notes.md` before you touch `lib/api/`, `lib/parser/` or
`lib/draft-guard.ts`. It records which verb each wire route owns and where the known
problems are.

---

## Layout

```
registry.ts            static, sorted command registry ({module, help, desc} per command)
commands/<name>/       index.ts (args + CommandModule), help.txt, desc.txt
lib/
  api/                 adApi façade: index.ts dispatches, v1.ts / v2.ts wire calls,
                       changelog.ts (change notes, /users/me)
  api-version.ts       AdOperation → DEFAULT_VERSION / SUPPORTED_VERSIONS (save = v2, rest v1)
  args/common.ts       AD_COMMON_FLAGS (--v2), AD_YES_FLAG, AD_NOTE_FLAG, resolveAdCommon
  args/confirm.ts      confirmation prompt for writes (--yes; mandatory in --llm)
  types/               common.ts = HydratedMethod / ParsedStep (commands import ONLY this);
                       v1-wire.ts / v2-wire.ts = raw wire (parsers, serializer, api only)
  parser/              v1.ts / v2.ts → HydratedMethod; steps/classify.ts classifies a step
                       by service identity (SQL / SPEL_ECHO / REDIS_* / CUSTOM_CODE / EXISTING_SERVICE)
  hydrator.ts          V1 service-definition lookup + cache (buildServiceResolver)
  ids.ts               resolveMethodRef: any uuid spelling / AD URL → 32-hex (INVALID_UUID)
  categories.ts        one category identity (chain category ⨝ automation system)
  draft-guard.ts       resolveDraftTarget: the ONLY way to pick a save target
  cache.ts             method cache (CacheManager)
  method-finder.ts     cached method index behind `find`, `callers`; invalidateMethodIndexEntry
                       (called by CacheManager.invalidate after each write, and by create)
  method-view.ts       show --compact / --story renderers
  compact.ts           pruneEmpty, --fields a,b|all projection (parseFieldList/projectRow)
  serialize/           v2.ts planV2Overlay (leaf overlay), ops.ts applyStructuralOps,
                       compact.ts compact step format + expansion, diff.ts path diffing
  save/                pipeline.ts saveOverlayV2 / verifySaved / verifyStructural,
                       validation.ts runValidationGate, api.ts postChainV2 / deleteChainV2,
                       compiled-cache.ts, create.ts, services.ts, sources.ts, flags.ts,
                       spec.ts (spec file → V2 body: create, lint, validate)
  validate/            pre-save validator (see below) + lint.ts (ad lint rules)
  test-run.ts          runInlineTest: one /chain/test run → outputs + trace
  payload-builder.ts   buildV1TestPayload: the one /chain/test body (test, run-suites, sql)
  test-cases/          expect.ts (--expect / assertions), case-file.ts, suite.ts, files.ts
  test-suite.ts        summarizeTestSuite (test-cases, test-case list)
  sql/                 executor, payload builder, DB selector, read-only gate, tui/
  history.ts           getVersionOf / listAll (history, diff)
  fingerprint.ts       fingerprintMethod (behaviour hash: wire body minus bookkeeping and numeric
                       …Ids, other …Uuids normalised; compare V2/history bodies only — state and
                       publish read both sides on V2; restore, trace). Cross-env / cross-endpoint
                       noise is normalised: default `encodedBase64`/`runAsync`/`required` false =
                       absent, `databaseRead.account` numeric/"null" dropped (account hashed by
                       name), service/category names without whitespace, method-output fieldCode
                       equal to its key dropped (tests/fixtures/cross-env: real dev/qa pairs)
                       + methodDiffView
  trace.ts             traceMethod (ad trace, release matrix)
  callers.ts           reverse index (ad callers); reads PD via @belzabar/pd/lib/*
  api-shape.ts         child-info --shape
  stream-parser.ts     application/stream+json (run --stream)
  error-parser.ts, input-collector.ts, base64.ts
docs/api-notes.md      wire cheatsheet (routes, auth modes, platform facts)
tests/unit/            bun tests; tests/fixtures/ = sanitized real sems-dev wire
```

---

## Commands

Read-only unless marked. **W** means a write: `writes` is set, so `--env` must be
given explicitly (D6), and the command asks for confirmation. In `--llm` mode it
needs `--yes` instead.

| Command | What it does |
|---|---|
| `find [list\|pick\|<query>]` | Cached method index: category counts, fzf picker, ranked search (`totalMatches` counts every match, before `--limit`); `--describe`, `--category` (name prefix / id / uuid; without a query it lists that category's methods: `data.methods`, `totalMethods`; also scopes `--raw`), `--fields`, `--refresh` |
| `fetch <uuid\|url>` | Fetch + cache + hydrate (`--v2`; `--raw` adds the wire body as `data.raw`) |
| `show <uuid\|url\|file>` | Method view. Lean `--llm` payload; `--compact` (one line per step), `--story` (approval Markdown), `--sql`/`--code`/`--full`, `--service-detail N` (alias `--step`), `--raw`, `--open`. `--compact`/`--story` always read V2 fresh (keys match save ops / create specs; V1 fallback with a warning) and carry `source`/`fetchedAt`. A local V1/V2 JSON file is shown without a fetch |
| `show-code`, `outputs`, `state` | Decoded custom code; the I/O contract only; draft/published linkage + `inSync` |
| `categories`, `services`, `child-info` | Categories (`--search`); the service catalog (`--search`), or `services <SERVICE>` = its methods (the names compact steps take; `--all`, `--search`); a callee's contract (`--shape`) |
| `callers <uuid>` | AD methods (and PD pages/components with `--pd`) that call the method. `coverage.complete` only for a fresh, full index with nothing unresolved; `coverage.skippedCategories` for failed listings |
| `export`, `export-category`, `test-cases`, `test-report` | Export JSON; list test cases (`METHOD_NOT_FOUND` for an unknown/soft-deleted uuid, since the suite route answers it like "no suite"); the latest suite report |
| `history list\|show\|diff`, `diff`, `trace` | Version history, history or cross-env semantic diff (`diff` opens an editor only in human mode or with `--editor`; a failed spawn is a warning), where a method is on every env |
| `validate <uuid\|file>` | Validator L1–L3 (`--online` L4, `--dry-run-compile` = **W**, `--strict`). A file may be a V2 body or a compact create spec (expanded first via `lib/save/spec.ts`, `data.spec`; `--category`) |
| `lint <uuid\|file>` | Validator + advisory review rules (`--online`, `--docs`, `--strict`); same file handling as validate |
| `sql dbs\|run\|explain` | Read-only SQL. `run`/`explain` accept one read statement (`SQL_NOT_READ_ONLY`) |
| `sql update\|insert\|modify\|tui` | **W** SQL writes (tui can switch into write modes) |
| `save [file] --uuid <uuid>` | **W** overlay / structural ops onto the DRAFT (`--dry-run` is not a write but still needs `--env` — `requiresEnv`, it reads the target draft; `--dry-run --dry-run-compile` is a write, since it POSTs `/chain/test`) |
| `create --spec <file>` | **W** new DRAFT from a compact spec or a V2 body (`--dry-run` is not a write but still needs `--env`; with `--dry-run-compile` it is a write) |
| `publish <uuid> --note "…"` | **W** validate, publish, record the note, evict the compiled cache |
| `delete <uuid>` | **W** soft-delete a never-published DRAFT |
| `import <file>`, `category create <name>` | **W**. import refuses an empty/invalid file (`AD_IMPORT_EMPTY`/`_INVALID`, `FILE_NOT_FOUND`), PUBLISHED records or targets (`AD_IMPORT_PUBLISHED`/`_TARGETS_PUBLISHED`), and validator errors on V2 records; the route 400s on sems-dev |
| `changelog <uuid> [--note "…"]` | List notes; `--note` is **W** (draft-guarded) |
| `history restore <draftUuid> --version N` | **W** draft-guarded restore; fails `RESTORE_UNCONFIRMED` unless the re-read draft matches the target content (fingerprint projection; `contentDiff` names differing paths); evicts the compiled cache; reports validator findings |
| `test <uuid>` | **W** (really runs the chain). `--inputs <file|json>`, `--input k=v` (repeatable, typed; on top of --inputs/--case), `--case`, `--expect`, `--compare-published` (runs the published copy too: confirms, `--yes`). A FAILED execution exits 1 `AD_TEST_FAILED` |
| `test-case <action>` | `list`, `export` and `sync` (dry run; needs `--env`) are reads. `create`, `update`, `delete`, `bulk`, `run-suite`, `delete-suite` and `sync --apply` are **W** |
| `run <publishedId>`, `run-suites`, `save-suite` | **W** live execute of the uuid's own saved body — a draft uuid runs the draft; `data.publishedUuid` names the published copy (`--stream`); **W** run local `suites/*.spec.json` (a malformed file fails alone as INVALID_JSON; a suite saved on another env is ENV_MISMATCH, not run; a legacy suite with no `env` is ENV_MISSING, not run, unless `--legacy-env` equals `--env`); save a local suite (records `env`) |

`desc.txt` for each command lists every invocation variant. `belz --help-full` prints
all of them together.

---

## Contracts

### Envelope, errors, `--v2`
- Commands return `ok(data)` or throw `CliError(message, {code, details})`. With
  `--llm`, the runner wraps the result in the core envelope
  `{schema:"ad.<cmd>", version, ok, command, data, error, meta}`. Machine output
  never goes through `console.log`.
- Error codes are stable and documented in each help.txt. The main families:
  - `INVALID_UUID`, `METHOD_NOT_FOUND` (an unknown uuid, or a 200 with an empty body)
  - `AD_DRAFT_GUARD_*`
  - `AD_OVERLAY_{UNKNOWN_KEY,INVALID,NOT_APPLIED}`, `AD_SERIALIZER_DRIFT`
  - `AD_SPEC_*`, `AD_VALIDATION_FAILED`, `AD_VERSION_CONFLICT`, `AD_SAVE_REJECTED`,
    `AD_SAVE_VERIFY_FAILED`
  - `AD_METHOD_EXISTS`, `AD_CATEGORY_PROTECTED`, `AD_IMPORT_*`
  - `AD_DELETE_PUBLISHED`, `AD_DELETE_HAS_PUBLISHED`
  - `AD_TEST_EXPECTATION_FAILED`, `AD_TEST_FAILED`, `AD_TESTCASE_*`, `AD_LINT_FAILED`
  - `HISTORY_*`, `RESTORE_UNCONFIRMED`
  - `SQL_*`
  - `AD_CONFIRMATION_REQUIRED` (in `--llm` without `--yes`)
- Every command accepts `--v2`. `resolveAdCommon(flags, op, cmd)` resolves it through
  `lib/api-version.ts`. If the operation has no V2 path, it falls back to V1 and
  prints a one-line notice on stderr. To flip a default, edit one cell of
  `DEFAULT_VERSION`. `save`, `create` and `delete` always use V2.
- Any command that takes a method uuid parses it with `resolveMethodRef`.
- Never call `response.json()` on a server response. V1 routes go through
  `lib/api/v1.ts:readJson` (status check + core `readJsonOrNull`): a 2xx with an
  empty or `null` body is `null`, a non-JSON body is `HTTP_BAD_JSON`. Everything
  else uses core `readJsonOrNull` / `expectJson` directly. (CLI trial: the suite
  GET answers a method without a suite with 200 + empty body, and a raw
  `.json()` crashed every `test-case` action with UNHANDLED_EXCEPTION.)
- Long server operations pass `AD_LONG_OP_TIMEOUT_MS` (10 min): test, execute,
  publish, suites and restore.

### Draft guard
Every write that changes a method goes through `lib/draft-guard.ts:resolveDraftTarget`.
The guard behaves as follows:
- A PUBLISHED uuid is switched to its linked draft (`switchedFromPublished`).
- A missing state fails closed (`AD_DRAFT_GUARD_STATE_UNKNOWN`).
- Never POST a save body whose uuid resolves to PUBLISHED. The server would silently
  overwrite production.

### Save pipeline (`lib/save/pipeline.ts:saveOverlayV2`, D1 = V2 route)
The steps run in this order:
1. The draft guard runs, then a fresh `GET /chain/v2`.
2. The plan is built:
   - `planV2Overlay` for leaf keys (`name`, `summary`, `description`,
     `parsedSteps[{orderIndex, source|sql|expression|description}]`).
   - `applyStructuralOps` for `ops[]`.
   - `--sql-file` / `--code-file N=path` become update-step ops (`lib/save/sources.ts`).
   - Every step not touched and every field not set must stay byte-identical,
     otherwise the plan fails with `AD_SERIALIZER_DRIFT`.
3. The validation gate runs (`lib/save/validation.ts`), controlled by `--no-validate`,
   `--strict` and `--dry-run-compile`. `--dry-run` returns
   `{valid, validation{errors, warnings}}` and writes nothing.
4. Confirmation.
5. A freshness re-GET. If the draft changed since step 1, the save fails with
   `AD_VERSION_CONFLICT`. The server ignores `metadata.version`, so belz must check
   this itself.
6. `POST /chain/v2`. A rejection returns `AD_SAVE_REJECTED` with the server's message.
7. A verify re-GET (`verifySaved`, or `verifyStructural` for ops and create). Every
   sent value must read back, otherwise `AD_SAVE_VERIFY_FAILED {notLanded, unexpected}`.
   Everything the ops removed (step outputs/inputs, a loop, an output binding,
   method inputs/variables/outputs — `structuralRemovals`) must be gone too; a
   removal the server ignored is `notLanded` (ADW-R7).
   Server bookkeeping is ignored: `metadata.version`, `metadata.internal`,
   `changelogs` and `testSuite`.
8. The compiled cache is evicted on BOTH `/rest/api/cache/invalidate` and
   `/rest/api/automations/cache/invalidate`, and the local method cache is dropped.
   This happens even when the POST or the verify failed.

Some rules that apply across the pipeline:
- The save never POSTs `testSuite`. A body that carries it makes the server rebuild
  the suite from a possibly stale copy.
- Keys the V2 route answers 200 to and then drops are refused with
  `AD_OVERLAY_NOT_APPLIED`: `buttonLabel`, `internalMethod`, `inputs[].testValue`,
  and a variable's BASE_64 encoding.
- Custom code keeps its stored encoding. SQL keeps its slot's `encodingType`.

`publish` validates the draft first. Findings that the published copy already has
still block unless `--allow-preexisting`. After the confirmation it re-reads the
draft (`assertDraftUnchanged`, shared with save) and refuses with
`AD_VERSION_CONFLICT` if it moved since it was validated (ADW-R5). The publish runs BEFORE the note is
recorded: the note gets three attempts, and if it still fails the result reports
`noteRecorded:false` and the publish stays. Afterwards the compiled cache of both
draft and published is evicted.

`create`:
- Builds the body with `lib/save/create.ts:buildCreateBody` and POSTs `/chain/v2`
  without a uuid.
- Refuses core categories (Helpers.*, Database.*, Cache.*, Email.*, Expertly.*,
  Web Socket, system services).
- Fails with `AD_METHOD_EXISTS` when the name is already taken.
- Verifies the result on a re-read.

`delete` does a soft `DELETE /chain/v2/{uuid}`. It succeeds only for a draft that was
never published. It is verified when a V2 re-read returns METHOD_NOT_FOUND; V1 keeps
serving deleted records.

### Structural ops and the compact step format
Ops are applied in order. Step numbers are **always positions in the fetched draft**
(the numbers `ad show` prints).
```json
{"op":"add-step", "after":2, "step":{"sql":"SELECT 1"}}      // after:0 = first; no anchor = append
{"op":"remove-step", "step":3}
{"op":"move-step", "step":4, "before":1}
{"op":"update-step", "step":2, "set":{"when":"#{x} ne null", "removeOutputs":["y"]}}
// set.outputs MERGES (upsert by fieldCode); set.replaceOutputs REPLACES the list (listed fieldCodes keep their uuid)
{"op":"set-input" | "set-variable" | "set-output", "key":"k", "type":"TEXT", "required":true, "default":"…"}
{"op":"remove-input" | "remove-variable" | "remove-output", "key":"k"}
```
The compact step format is shared by `ops` and `create --spec`, and is defined in
`lib/serialize/compact.ts`.
- **Step source:** `service "Svc/method"`, `code` / `codeFile`, or `sql` / `sqlFile`.
  With `sql`, the verb picks `db_service` `data.read`/`add`/`update`/`delete`. File
  paths are relative to the spec.
- **Inputs:** `{"key": v, "body.nested": v}`.
- **Outputs:** `["key"]`, `[{key, as, var, type, elementToRetrieve}]` or `{as: key}`.
- **Flow control:**
  - `when` sets the entry condition.
  - `exit {onFailure, code, message}` sets the exit on failure.
  - `exitIf {when, code, message}` sets a conditional exit.
  - `loop` is one of `{over}`, `{times}`, `{while}` or `{from, to, by}`, plus
    `counter`, `parallel` and `threads`.
- **Other keys:** `account` (db_service), `description`, `language`, `async`.

Keys are checked online against the callee contract
(`lib/save/services.ts:loadServiceCatalog`, cached 1 h). Input and output keys, services
and accounts that the callee doesn't have are refused, because the server would drop
them.

A create spec adds `name`, `category`, `summary`, `description`, and
`inputs`/`variables`/`outputs`. Each of those is a key string or
`{key, type, required, default, description}`. A spec may also be a raw V2 body or a
subset of one. Server-owned keys are dropped and listed in `dropped`.

### Validator (`lib/validate/`, runs on the V2 wire body)
- **L1** `schema.ts`: zod structure, enums, key patterns.
- **L2** `steps.ts`: per-step rules for custom code (a compile-only JS parse), SQL,
  SpEL, conditions, loops and encodings.
- **L3** `graph.ts`: the reference graph (`#{root}` defined before use, output refs,
  dead steps).
- **L4** `online.ts`, opt-in:
  - The callee contract, from `GET /automation-systems/{svc}/automation-apis/{uri}`.
  - Service accounts.
  - Both are cached 1 h in `~/.belz/cache/{api-contracts,service-accounts}/<env>/`.
  - `--dry-run-compile` POSTs the body as a V1 inline test with every step gated off,
    so nothing executes.

The entry points in `index.ts` are `validateMethodV2` (L1–L3, pure) and
`validateOnline` (+L4).

Validation is **diff-aware**. A finding that is also present in `before` becomes a
`preexisting` warning, and `--strict` promotes only new warnings. A finding's
identity (ADW-R3/R4) is rule + path with the step index replaced by the aligned
`before` step (same id, else an in-order match on service/type — `alignSteps`,
which is how a draft lines up with its published copy), other array indices
replaced by the element's `key`, plus the leaf value at the path — or, for a
TEXT leaf (SQL / code / template: >80 chars or multi-line), the finding message
with step numbers and line/column normalised away. A different broken short
value at the same path, a different dangling ref in the same SQL, or a new
output on an old output's index, is new; an unrelated edit elsewhere in the
same SQL/code body keeps its old findings pre-existing (so publish's
`--allow-preexisting` can clear them). A second finding of a fixed-message rule
(Q5, CC3) in a body that already had one is treated as pre-existing.

Calibration is pinned in `tests/unit/validate-diff.test.ts` WITHOUT self-diffing (ADW-R15): the 36
real bodies audited as stored (`auditExistingRecord`, what `ad validate <uuid>`
reports: no AD-META-001 on PUBLISHED records, M1 on an existing name is a warning)
leave only 21 documented real defects on 7 bodies. CI1 and DUP1 are warnings (they
fire on working production methods); `--strict` blocks new ones.

Rule codes live in `catalogue.ts`. The team's codes (M1, CI1, LP3, …) keep their
meaning; belz rules are named `AD-<FAMILY>-nnn`. To add a rule:
1. Add it to the catalogue.
2. Emit it with `report({rule, message, path, step})`.
3. Add a positive and a negative row to the validate-l1 / -rules / -online tests.

`lint.ts` defines the advisory `LINT_RULES`: Q2–Q4 and `AD-LINT-001`…`010`. They are
always warnings, and save and publish never run them. Their counts are pinned in
`tests/unit/lint.test.ts`.

### Tests: `--expect` and test cases (`lib/test-cases/`)
`--expect` syntax:
- Comparisons: `out=v`, `out!=v`, `out~=v` (contains), `out>v`, `out<v`, `out>=v`,
  `out<=v`.
- `out.a[0].b=v` looks inside an output that holds JSON.
- The right-hand side is read as JSON when it parses, otherwise as text. Quote it to
  force a string.
- Any failure exits 1 with `AD_TEST_EXPECTATION_FAILED`.

Test-case assertions are stored as the UI's advance-mode SpEL (`#{out} eq 'v'`), which
supports only eq, neq, gt, lt and contains.

The case-file format is
`{name, description, inputs{fc: value}, inputExtras?, assertions[{output, op, expected}|{expression}]}`.

`test-case export --dir <root>` writes `<root>/<Category>/<method>/{method.json, cases/*.json}`.
`method.json.uuids` maps each env to its chain uuid. `sync` builds the plan, and
applies it only with `--apply`.

Test-case writes are contract-checked and verified by re-reading the suite. Platform
facts to keep in mind:
- A method with no suite: the suite GET answers 200 + empty body (belz: no suite,
  0 cases). The first `POST /chain/testcases/{uuid}` creates the suite.
- `PUT` persists only inputs and assertions.
- `DELETE` is soft and never frees the name (`AD_TESTCASE_NAME_RESERVED`).
- `bulk` posts one case at a time.

### SQL
Default DB when `--db` is absent, in order:
1. `environments.<env>.sqlDefaultDb` in `~/.belz/config.json`
2. `BELZ_SQL_DEFAULT_DB`
3. `NSM_Read_DB` (NSM only)

`selectedBy` reports which one was used.

`run` and `explain` accept one read statement only; comments and literals are
stripped before the check. Any `#{` is refused outright (ADW-R1): the query is
sent with `combineInputs:true`, so the server evaluates SpEL — even inside
literals — and splices the result into the SQL before the DB runs it. `EXPLAIN` is judged by its inner statement, so
`EXPLAIN ANALYZE DELETE …` is refused.

`insert … RETURNING <col>` returns the generated values.

### Caching (core `Cache`, env-scoped)
| Cache | Location under `~/.belz/cache/` | TTL | Evicted by |
|---|---|---|---|
| Methods | `methods/<env>/<uuid>.json` | 5 min soft (SWR) / 1 h hard | save, publish, delete, history restore; `show --force` bypasses. A V1 parse with failed definition lookups (`unresolvedServices`) is never cached |
| Service definitions | `definitions/<env>/<automationId>.json` | 1 h | — |
| Method index | `method-finder/index-v1-<env>.json` (+ `dirty-<env>.json`) | 7 days (`callers`: 24 h; partial index: 15 min) | `find --refresh`, `callers --refresh`; `ad import` drops it. belz writes mark the uuid dirty, and `callers` re-reads dirty methods. A V2 read answering METHOD_NOT_FOUND (deleted / unknown) marks the uuid gone (`gone-<env>.json`): `find`/`callers` drop it from the cached index at once; a rebuild clears the marks |
| Callers | `callers/`, `callers-errors/` (1 day), `pd-ad-refs/` (1 h) | — | `callers --refresh` |
| Published history bodies | `history-versions/<env>/<methodVersionID>.json` | 30 days (immutable) | — |
| Validator L4 | `api-contracts/`, `service-accounts/` | 1 h | — |

---

## Adding or changing a command
1. Create `commands/<name>/index.ts`:
   - Export `args` built with core `defineArgs` / `defineSubcommands`, spreading
     `AD_COMMON_FLAGS` (and `AD_YES_FLAG` for writes).
   - `parseArgs` calls `args.parse(argv)`.
   - Set `writes` for anything that changes or executes remote state.
   - A save-like write goes through `resolveDraftTarget` and `lib/save/`.
2. Add `help.txt` (template below) and `desc.txt`. `desc.txt` has one line per
   invocation variant: `belz ad <cmd> <args> --flag  :->  what it does`.
   `apps/cli/tests/args-docs.test.ts` fails when either file drifts from `args`.
3. Add the command to `registry.ts`, keeping it sorted.
   `apps/cli/tests/registry.test.ts` fails when the folder and the registry disagree.
4. Add a test (next section), and update this file.

### help.txt template
```
Usage: belz ad <cmd> <REQUIRED_ARG> [OPTIONAL_ARG] [flags]

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
  belz ad <cmd> <example1>
  belz ad <cmd> <example2> --flag
```
Rules:
- The prefix is `belz ad`, `belz pd`, or plain `belz` for top-level commands.
- Required positionals are uppercase in `<>`. Optional ones go in `[]`.
- Flag descriptions are aligned in one column. End them with `(required)` or
  `(default: X)` where that applies.
- `--help, -h` is the last Flags entry.
- The file always has a Global Flags section, and write commands say that `--env` is
  required.
- Give 2–3 real Examples. Put a blank line between sections.
- Extra sections (Notes, Errors, Data, Rules) go before Examples.

---

## Testing
- `tests/unit/*.test.ts` run under `bun test`. The root `bunfig.toml` preload points
  `BELZ_HOME` at a temp dir.
- **fakeFetch** comes from `@belzabar/core/testing`, along with `fixture(path)`,
  `respond`, `withTempEnvConfig` and `runCommand` / `runCliInProcess`. Use it to drive
  a command end to end without the network. See `save-command.test.ts` and
  `author-commands.test.ts`.
- **Fixtures** in `tests/fixtures/` are real sems-dev wire, sanitized, and each
  directory has a `manifest.json`:
  - `real-v1/` and `real-v2/`: the same 36 methods, one set per wire version.
  - `definitions/`, `categories/`, `child-info/`, `callers/`, `history/`,
    `test-cases/`, `not-found/`, `services/` (a service's automation-apis listing).
  - `validate/`: the validator golden set plus live case patches.
  - `cross-env/`: published history bodies of the same logic on sems-dev and
    sems-qa (read-only History.get), for the cross-env fingerprint tests.
  - `v1/step-*.json` are hand-written, but prefer real fixtures.
  - Refresh fixtures from the repo root with `bun scripts/fixtures/capture.ts <target>`.
    It only issues GETs and only talks to sems-dev.
- Suites that pin real-data invariants:
  - `real-wire.test.ts`: V1↔V2 parse parity.
  - `save-v2-overlay.test.ts`: the overlay round-trip over the 36 bodies.
  - `validate-diff.test.ts`, `lint.test.ts`: calibration counts.
- **Live suites** live in `apps/cli/tests/live/` and are opt-in:
  - `BELZ_LIVE=sems-dev bun test apps/cli/tests/live` runs the read-only suite.
  - Adding `BELZ_LIVE_WRITE=1` also runs the full lifecycle write suite in category
    Test-Parth (create → validate → save → test → test-case → publish → state →
    history → delete).
  - CI never sets these variables.
- Every bug fix gets a regression test. Run `bun run check` (typecheck + tests) before
  committing.

---

## Maintainer instructions
When you change this module (commands, flags, behaviour, lib files, output shapes),
update this file, the command's `help.txt` / `desc.txt`, and `registry.ts` in the same
commit. Keep `--llm` envelopes stable, because agents parse them.
