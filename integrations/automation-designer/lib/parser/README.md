# lib/parser — wire body → `HydratedMethod`

Turns a raw V1 or V2 method body into the one version-neutral shape the commands use
(`HydratedMethod` / `ParsedStep`, [`../types/common.ts`](../types/common.ts)).

| Path | Contents |
|---|---|
| `index.ts` | Re-exports `parseV1Method` and `parseV2Method`. |
| `v1.ts` | `parseV1Method`: JSON-parses the stringified `jsonDefinition`, maps inputs, outputs, variables and state, and parses each step. |
| `v2.ts` | `parseV2Method`: the same mapping from the flat V2 body. |
| `steps/` | One parsed step per wire step, and service classification. See [`steps/README.md`](steps/README.md). |

## Contracts

- Both parsers produce the same shape; `sourceVersion` records which wire it came from.
- **Every parsed step keeps its original wire JSON in `step.raw`.** Never drop it or clone it
  in a way that loses unknown fields: presenters and the fingerprint read it.
- **No behaviour field is dropped.** Entry condition, loop, exit-on-failure, conditional exit
  (`forceReturn*`: V1 `forceReturnConditionExpression`, V2 `exitCondition.conditionalExit`),
  async, account, and method deprecation / scope / timeout are all on the parse.
  `tests/unit/parsed-fields-guard.test.ts` fails on any fixture wire key that is set but
  neither parsed nor on its documented ignore list; a new key must be modelled or listed.
- A V1 body needs a service resolver to classify steps (its numeric API ids are env-local).
  `adApi.fetchMethod` builds one with [`../hydrator.ts`](../hydrator.ts); tests build one from
  `tests/fixtures/definitions`.
- Saves never re-serialize a parsed method: the V2 save overlays leaves onto the live V2 body
  ([`../serialize/README.md`](../serialize/README.md)).

Tests: `parser-v1-*.test.ts`, `parser-v2-*.test.ts` and `real-wire.test.ts` (V1↔V2 parse
parity over the real fixtures), `parsed-fields-guard.test.ts` in [`../../tests/unit`](../../tests/unit/README.md).

Up: [`../README.md`](../README.md)
