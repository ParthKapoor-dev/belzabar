# lib/save — the V2 write pipeline

Everything that writes a method body: `ad save`, `ad create`, `ad delete`, the validation gate
`ad publish` shares, and compiled-cache eviction. The edits themselves are planned by
[`../serialize/`](../serialize/README.md); this directory adds the network, the guard rails and
the verification.

| File | Contents |
|---|---|
| `pipeline.ts` | `saveOverlayV2` (the whole `ad save` flow), `assertDraftUnchanged` (freshness check, shared with publish), `verifyStructural` / `structuralRemovals` (post-write verify for ops and create), `dryRunValidation`. |
| `validation.ts` | `runValidationGate`: runs [`../validate/`](../validate/README.md), blocks on errors (and new warnings with `--strict`), fails `AD_VALIDATION_FAILED {errors, warnings, layersRun, preexistingCount}`. `--no-validate` skips it with a loud warning. |
| `flags.ts` | `VALIDATION_FLAGS`: `--no-validate`, `--strict`, `--dry-run-compile`. |
| `api.ts` | `postChainV2` (create without a uuid / update with the live body) and `deleteChainV2`. Error bodies are summarised and redacted. |
| `compiled-cache.ts` | `invalidateCompiledCache`: POSTs every route in `COMPILED_CACHE_ROUTES`, succeeds if any answers 2xx, reports each. |
| `create.ts` | `buildCreateBody` (spec → V2 create body), `assertCreatableCategory`, `compactSteps`. |
| `spec.ts` | A spec file → the body `create` would POST (`readSpecFile`, `expandSpec`, `loadTargetBody`); shared by `create`, `lint` and `validate`. |
| `sources.ts` | Reads `codeFile` / `sqlFile` references and turns `--sql-file N=path` / `--code-file N=path` into update-step ops. |
| `services.ts` | `loadServiceCatalog`: callee contracts and db accounts for the compact expander, cached 1 h (the validator's L4 cache). |

## Save pipeline (`saveOverlayV2`)

1. The draft guard ([`../draft-guard.ts`](../draft-guard.ts)) picks the target; its GET is the
   fresh live body.
2. The plan: `planV2Overlay` for leaf keys, `applyStructuralOps` for `ops[]`, file flags as
   update-step ops. Anything outside the targets must stay byte-identical
   (`AD_SERIALIZER_DRIFT`).
3. The validation gate. `--dry-run` stops here and returns
   `{valid, validation{errors, warnings}}`; nothing is written.
4. Confirmation (`--yes` in `--llm` mode).
5. Freshness re-GET: `AD_VERSION_CONFLICT` if the draft changed since step 1. The server
   ignores `metadata.version`, so this is the only lost-update protection.
6. `POST /chain/v2`. A rejection is `AD_SAVE_REJECTED` with the server's message.
7. Verify re-GET (`verifySaved`, or `verifyStructural` for ops): every sent value must read
   back, and everything the ops removed must be gone, otherwise
   `AD_SAVE_VERIFY_FAILED {notLanded, unexpected}`. Server bookkeeping is ignored:
   `metadata.version`, `metadata.internal`, `changelogs`, `testSuite`.
8. The compiled cache (both routes) and the local method cache are evicted, even when the
   POST or the verify failed.

A save never POSTs `testSuite`: a body that carries it makes the server rebuild the suite from
a possibly stale copy.

## Publish, create, delete

- **publish** (`commands/publish`) validates the draft; findings the published copy already
  has still block unless `--allow-preexisting`. After confirmation it re-reads the draft
  (`assertDraftUnchanged`), publishes, then records the change note (three attempts; a POST
  that may have reached the server is never re-sent, the changelog is checked instead). A
  failed note reports `noteRecorded: false` and the publish stands. Both chains' compiled
  caches are evicted.
- **create** builds the body with `buildCreateBody` and POSTs `/chain/v2` without a uuid. It
  refuses core categories (`Helpers.*`, `Database.*`, `Cache.*`, `Email.*`, `Expertly.*`,
  Web Socket, system services: `AD_CATEGORY_PROTECTED`) and taken names
  (`AD_METHOD_EXISTS`), drops server-owned keys (listed in `dropped`), and verifies on a
  re-read. A spec is a compact spec or a (subset of a) V2 body; `name`, `category`,
  `summary`, `description`, and `inputs` / `variables` / `outputs` as key strings or
  `{key, type, required, default, description}`.
- **delete** is a soft `DELETE /chain/v2/{uuid}`, allowed only for a draft that was never
  published, and verified when a V2 re-read answers `METHOD_NOT_FOUND`.

Compiled-cache eviction is never called with an empty uuid list: the server reads that as
"flush the whole organisation".

Tests: `save-command.test.ts`, `save-structural.test.ts`, `save-v2-overlay.test.ts`,
`create-delete.test.ts`, `publish-changelog.test.ts` in
[`../../tests/unit`](../../tests/unit/README.md).

Up: [`../README.md`](../README.md)
