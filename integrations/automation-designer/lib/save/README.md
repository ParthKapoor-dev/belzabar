# lib/save — the V2 write pipeline

Everything that writes a method body: `ad save`, `ad create`, `ad delete`, the validation gate
`ad publish` shares, and compiled-cache eviction. The edits themselves are planned by
[`../serialize/`](../serialize/README.md); this directory adds the network, the guard rails and
the verification.

| File | Contents |
|---|---|
| `pipeline.ts` | `saveOverlayV2` (the whole `ad save` flow), `assertDraftUnchanged` (freshness check, shared with publish), `verifyStructural` / `structuralRemovals` (post-write verify for ops and create), `dryRunValidation`. |
| `validation.ts` | `runValidationGate`: runs [`../validate/`](../validate/README.md), blocks on errors (and new warnings with `--strict`), fails `AD_VALIDATION_FAILED {errors, warnings, layersRun, preexistingCount}`; when a caller makes pre-existing findings block (publish) the message names its override flag (`preexistingFlag`). `--no-validate` skips it with a loud warning. |
| `flags.ts` | `VALIDATION_FLAGS`: `--no-validate`, `--strict`, `--dry-run-compile`. |
| `api.ts` | `postChainV2` (create without a uuid / update with the live body) and `deleteChainV2`. Error bodies are summarised and redacted. |
| `compiled-cache.ts` | `invalidateCompiledCache`: POSTs every route in `COMPILED_CACHE_ROUTES`, succeeds if any answers 2xx, reports each. |
| `create.ts` | `buildCreateBody` (spec → V2 create body), `assertCreatableCategory`, `compactSteps`. |
| `spec.ts` | A spec file → the body `create` would POST (`readSpecFile`, `expandSpec`, `loadTargetBody`); shared by `create`, `lint` and `validate`. |
| `sources.ts` | Reads `codeFile` / `sqlFile` references and turns `--sql-file N=path` / `--code-file N=path` into update-step ops. |
| `test-values.ts` | `storedTestValues` (V1 read of the inputs carrying a stored testValue; null when unreadable), the save's drop warning and the create note. |
| `preview.ts` | The dry run's preview: `previewChanges` (before/after of every changed field), `namedOrder`, `outputsToMethod`. |
| `name-check.ts` | `findNameConflict`: a rename onto a name or alias another method of the category holds (the category listing: unpublished drafts and published methods; exact match, as the server). `ad save` refuses it before the POST (`AD_METHOD_EXISTS`); `--dry-run` returns `nameConflict` and `valid: false`. |
| `output-keys.ts` | `fillOutputKeys`: writes a keyless method output's `key` from its fieldCode before the save (and adds it to the verify). |
| `normalise.ts` | `normalisedChange` / `splitNormalised`: server rewrites the verify accepts as unchanged (encoding flags, account label, condition form). |
| `case-guard.ts` | `guardTestCases` / `planCaseRestores`: puts back the test cases a V2 body write rewrote (shared by `ad save` and `ad history restore`). |
| `services.ts` | `loadServiceCatalog`: callee contracts and db accounts for the compact expander, cached 1 h (the validator's L4 cache). `fresh` reads online; the result lists which contracts came from the cache (`cachedAt`). |

## Save pipeline (`saveOverlayV2`)

1. The draft guard ([`../draft-guard.ts`](../draft-guard.ts)) picks the target; its GET is the
   fresh live body.
2. The plan: `planV2Overlay` for leaf keys, `applyStructuralOps` for `ops[]`, file flags as
   update-step ops. A refusal that a cached callee contract decided (an input, output, service or
   account it does not know) is planned once more on contracts read online now. Only that answer
   refuses, and its message says the contracts were re-read. Anything outside the targets must stay byte-identical
   (`AD_SERIALIZER_DRIFT`).
   Then the older-body repairs (`output-keys.ts`): a method output stored without a `key` gets
   it from its fieldCode (`outputKeysFilled`, a warning); a V2 save without one breaks every run
   ("key is null"). One V1 read ([`../v1-only.ts`](../v1-only.ts)) then carries the loops the
   older editor stored only in V1 into the body (`loopsCarried`) and lists the V1 mappings of
   callee inputs that no longer exist, which the save drops (`droppedMappings`; contracts are
   read only for steps with more V1 mappings than V2 inputs). Fills and carried loops are
   verified targets like the overlay's own.
3. The validation gate, and for a rename the name check (`name-check.ts`). `--dry-run` stops here and returns `{valid, validation{errors,
   warnings}}` plus the preview from `preview.ts`: `changes[{target, path, before, after}]`,
   `order` (new steps named `new#1`, `new#2`…) and `outputsToMethod`. Nothing is written.
4. Confirmation (`--yes` in `--llm` mode).
5. Freshness re-GET: `AD_VERSION_CONFLICT` if the draft changed since step 1. The server
   ignores `metadata.version`, so this is the only lost-update protection.
6. `POST /chain/v2`. A rejection is `AD_SAVE_REJECTED` with the server's message.
7. Verify re-GET (`verifySaved`, or `verifyStructural` for ops): every sent value must read
   back, and everything the ops removed must be gone, otherwise
   `AD_SAVE_VERIFY_FAILED {notLanded, unexpected, normalised}`. Server bookkeeping is ignored:
   `metadata.version`, `metadata.internal`, `changelogs`, `testSuite`. Server normalisation
   (`normalise.ts`) is not a change either. That covers an input's `encodedBase64` flag, a
   value that only moved between base64 and plain, a db step's account label gaining its name,
   `databaseRead.account` becoming the step's account id, and a condition moving between the
   basic and advanced form with the same expression. It is listed in `data.normalised` with a
   warning, and the save returns `ok` with the new version. `ad create`'s verify does the same.
8. The compiled cache (both routes) and the local method cache are evicted, even when the
   POST or the verify failed.
9. Stored input testValues: the V2 body has none, so a V1 GET before the save lists the inputs
   that carry one (`--dry-run` warns and returns `testValuesAtRisk`). When any did, a V1 re-read
   after the verify reports the dropped ones as a warning and `testValuesDropped`: every V2
   save strips them, and the designer's Test dialog then reports "Mandatory fields are not
   filled". Best effort; an unreadable V1 body never blocks the save.

Call-step output uuids: the V2 GET reports a call step's output mappings with the callee's
current contract output uuids, and each publish of the callee mints new ones (live 2026-11-18).
The stored body keeps the old uuids until the next save, which persists the uuids it read. A
description-only save can therefore "change" an untouched step's output uuids in
`ad history`. The verify compares V2 reads, which already carry the new uuids, so it passes;
this is not drift.

Version numbers: the first V2 save of a method the platform has not migrated yet
(`migrationVersion` null or a timestamp) migrates it. The server then restarts the draft's
version numbering and history at 1 (seen live: 71 → 1 and 25 → 1). The save warns when the
version read back is not higher than the one before. A save is confirmed by the verify, not by
the counter.

A save never POSTs `testSuite`: a body that carries it makes the server rebuild the suite from
a possibly stale copy.

Test cases (`case-guard.ts`): even without `testSuite` in the body, every V2 save makes the
server rewrite the persisted cases. It gives each input a case did not set a raw `{}`, and drops
inputs the method no longer has. A history restore also brings back that version's copy of the
suite. So the writer takes the cases from the freshness re-read, compares them with the verify
re-read, and PUTs every changed case back to its snapshot. The only change it keeps is the
removal of an input the method no longer declares. Each restored case is checked on one more
V2 read. The result is `data.testCases {changedByServer, restored, failed}`; a failed restore is
also a warning. `--keep-case-changes` reports the changes without restoring (`kept: true`).
This runs before the verify, so an `AD_SAVE_VERIFY_FAILED` carries `details.testCases` too.

## Publish, create, delete

- **publish** (`commands/publish`) validates the draft; errors the published copy already
  has still block unless `--allow-preexisting` (a pre-existing warning never blocks). After confirmation it re-reads the draft
  (`assertDraftUnchanged`), publishes, then records the change note on the draft and the
  published chain (three attempts; a POST that may have reached the server is never re-sent,
  the changelog is checked instead) and reads both back. A missing note reports
  `noteRecorded: false` and the publish stands. Both chains' compiled caches are evicted.
  What the publish does to the test suite and to callers of removed inputs is read by
  [`../publish-report.ts`](../publish-report.ts).
- **create** builds the body with `buildCreateBody` and POSTs `/chain/v2` without a uuid. It
  refuses core categories (`Helpers.*`, `Database.*`, `Cache.*`, `Email.*`, `Expertly.*`,
  Web Socket, system services: `AD_CATEGORY_PROTECTED`) and taken names
  (`AD_METHOD_EXISTS`), drops server-owned keys (listed in `dropped`), and verifies on a
  re-read. A spec is a compact spec or a (subset of a) V2 body; `name`, `category`,
  `summary`, `description`, and `inputs` / `variables` / `outputs` as key strings or
  `{key, type, required, default, description}`. A new draft stores no testValues, so a
  create with required inputs warns that the designer's Test dialog will ask for them.
- **delete** is a soft `DELETE /chain/v2/{uuid}`, allowed only for a draft that was never
  published, and verified when a V2 re-read answers `METHOD_NOT_FOUND`.

Compiled-cache eviction is never called with an empty uuid list: the server reads that as
"flush the whole organisation".

Tests: `save-command.test.ts`, `save-structural.test.ts`, `save-v2-overlay.test.ts`,
`create-delete.test.ts`, `publish-changelog.test.ts`, `save-case-guard.test.ts`, `save-normalise.test.ts` in
[`../../tests/unit`](../../tests/unit/README.md).

Up: [`../README.md`](../README.md)
