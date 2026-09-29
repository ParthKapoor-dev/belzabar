# AGENTS.md — Automation Designer (`@belzabar/ad`)

Working rules for agents changing this package. What the package is and how it works is in the
READMEs; read the one for the directory you touch before editing it.

## Where the docs live

| Topic | Doc |
|---|---|
| Package overview, exports, config, error families | [`README.md`](README.md) |
| Command map, help.txt template, adding a command | [`commands/README.md`](commands/README.md) |
| Library map, draft guard, caches | [`lib/README.md`](lib/README.md) |
| Wire routes, V1 vs V2 | [`lib/api/README.md`](lib/api/README.md) |
| Save / create / delete / publish pipeline | [`lib/save/README.md`](lib/save/README.md) |
| Overlay, structural ops, compact step format | [`lib/serialize/README.md`](lib/serialize/README.md) |
| Validator and lint rules | [`lib/validate/README.md`](lib/validate/README.md) |
| `--expect`, test cases, suites | [`lib/test-cases/README.md`](lib/test-cases/README.md) |
| SQL | [`lib/sql/README.md`](lib/sql/README.md) |
| Tests and fixtures | [`tests/README.md`](tests/README.md), [`tests/unit/README.md`](tests/unit/README.md) |
| A command's flags and output | its `help.txt` (`belz ad <cmd> --help`) |

## Standing instructions

- A change to a command's flags, behaviour or output updates its `help.txt` and `desc.txt` in
  the same commit; a new or removed command also updates `registry.ts` (sorted) and
  [`commands/README.md`](commands/README.md).
- A change to a lib file's role, a contract, a cache or a directory updates that directory's
  README in the same commit. Keep READMEs accurate against the code; `bun run docs:check`
  verifies the paths and `belz` commands they mention.
- Keep `--llm` envelopes and error codes stable: agents parse them.
- Every bug fix gets a regression test (fakeFetch plus real fixtures; see
  [`tests/unit/README.md`](tests/unit/README.md)). `bun run check` must pass before committing.
- No project or client names, hosts, ticket or stage ids in code, tests or docs.

## Contracts you must not break

- **Draft only.** Every write that changes a method goes through
  `lib/draft-guard.ts:resolveDraftTarget` and, for bodies, `lib/save/`. Never POST a body whose
  uuid resolves to PUBLISHED: the server would overwrite production.
- **Saves overlay, never re-serialize.** The V2 save sends the live GET body with only the
  target leaves changed; anything else fails `AD_SERIALIZER_DRIFT`. Keep the freshness re-read
  (the server has no optimistic locking) and the post-save verify.
- **`step.raw` is load-bearing.** Every parsed step keeps its wire JSON; never drop it or strip
  unknown fields.
- **Types boundary.** Code that reads a method uses `lib/types/common.ts`; only raw-body code
  imports the wire types.
- **No `response.json()`** on server responses: use `lib/api/v1.ts:readJson` or core
  `readJsonOrNull` / `expectJson` (several routes answer "nothing" with an empty 200).
- **Writes are declared.** `writes` is set on anything that changes or executes remote state
  (including `test`, `run`, `run-suites`, and `--dry-run-compile`); they confirm, or need
  `--yes` in `--llm`.
- **Classification by service identity**, never by env-local numeric ids.
- **Compiled cache.** Evict it after every write that changes a method body, even on failure,
  and never with an empty uuid list.
- **Calibration counts** in `validate-diff.test.ts` and `lint.test.ts` change only on purpose.

## Platform traps agents hit

These are documented where runtime agents look (`ad save --help`, `ad create --help`,
`ad outputs --help`); keep those help texts in sync if the behaviour changes.

- db_service `flatData[]` is an array of row objects: `--expect 'out[0].col=v'`.
- Custom-code steps take no inputs: `#{x}` is spliced into the JS as text. Splice scalars only;
  an indexed expression or a list/object breaks.
- A step output whose `as` is not declared on the method is not returned.
- Step output keys cannot be indexed or pathed; bind the list, then read it in an echo step
  (`indexedOutputHint` names the pattern).
- A db_service step's `account` defaults only when the service has exactly one account on the
  env; otherwise the error lists them as `id=nickname`.
