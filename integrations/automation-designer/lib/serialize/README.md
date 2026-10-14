# lib/serialize — edits onto a live V2 body

Pure code (no network) that turns an `ad save` overlay, structural ops, or a compact
`ad create` spec into a V2 wire body. The save pipeline ([`../save/README.md`](../save/README.md))
supplies the live body and the callee contracts and does the I/O.

| File | Contents |
|---|---|
| `v2.ts` | `planV2Overlay(live, overlay)`: the live V2 GET body with only the overlay's target leaves replaced, plus the target paths and what did not change. |
| `ops.ts` | `applyStructuralOps`: add / remove / move / update steps and upsert / remove method inputs, outputs and variables. Returns the new body and the touched paths. |
| `compact.ts` | The compact step format: `expandCompactStep`, field expansion (`expandField`, `mergeField`), SQL slot helpers (`encodeSql`, `findSqlSlot`), `indexedOutputHint`, and the `Problems` collector. |
| `diff.ts` | JSON path helpers shared by the overlay check, the freshness re-read and the post-save verify (`diffPaths`, `getAtPath`, `isUnder`, `jsonEqual`). Paths look like `steps[2].properties.customCode.inlineCode`. |

## Overlay (`v2.ts`)

Accepted keys: `name`, `summary`, `description`, `inputs[{code, testValue}]`,
`parsedSteps[{orderIndex, source | sql | expression | description}]` and `ops[]`.

- Unknown keys fail `AD_OVERLAY_UNKNOWN_KEY`; bad value types fail `AD_OVERLAY_INVALID`.
- Keys that would not land fail `AD_OVERLAY_NOT_APPLIED`: a missing or ambiguous step, a field
  on a step of another kind, and fields the V2 route accepts with 200 and then drops
  (`buttonLabel`, `internalMethod`, `inputs[].testValue`, a variable's `BASE_64` encoding). An
  overlay that changes nothing fails the same way.
- The planned body may differ from the live body only at target paths; anything else fails
  `AD_SERIALIZER_DRIFT`. Metadata, step ids, changelogs and permissions go back verbatim, which
  the server's state check requires.
- Custom code keeps its stored encoding; SQL keeps its slot's `encodingType`.

## Structural ops (`ops.ts`)

Ops apply in order. Step numbers are **always positions in the fetched draft** (the numbers
`wi-impl ad show` prints), whatever earlier ops did, so every op can be written from one read.

```json
{"op":"add-step", "after":2, "step":{"sql":"SELECT 1"}}
{"op":"remove-step", "step":3}
{"op":"move-step", "step":4, "before":1}
{"op":"update-step", "step":2, "set":{"when":"#{x} ne null", "removeOutputs":["y"]}}
{"op":"set-input", "key":"k", "type":"TEXT", "required":true, "default":"v"}
{"op":"remove-output", "key":"k"}
```

- `after: 0` places a step first; no anchor appends. Several steps after one anchor keep op
  order.
- `set-input` / `set-variable` / `set-output` upsert; `remove-input` / `remove-variable` /
  `remove-output` delete.
- In `update-step`, `set.outputs` merges by fieldCode and `set.replaceOutputs` replaces the
  list (listed fieldCodes keep their uuid).

## Compact step format (`compact.ts`)

Shared by `ops` and `ad create --spec`. Every key is optional except what the step kind needs.

| Key | Meaning |
|---|---|
| `service` | `"Service/method"`, e.g. `"Helpers.Legacy/echo"` |
| `code` / `codeFile` | Custom code (`language` JAVASCRIPT by default, or PYTHON) |
| `sql` / `sqlFile` | A `db_service` step; the verb picks `data.read` / `add` / `update` / `delete` |
| `account` | db account id or nickname; may be omitted only when the service has exactly one account on the env |
| `inputs` | `{"key": value, "body.nested": value}`; keys are the callee contract's input keys |
| `outputs` | `["key"]`, `[{key, as, var, type, elementToRetrieve}]` or `{as: key}` |
| `when` | Entry condition (SpEL); `null` clears |
| `exit` / `exitIf` | `{onFailure, code, message}` / `{when, code, message}` |
| `loop` | `{over}`, `{times}`, `{while}` or `{from, to, by}`, plus `counter`, `parallel`, `threads` |
| `description`, `async` | Step description, `runAsync` |

- `codeFile` / `sqlFile` paths are relative to the spec or overlay file and are read by
  [`../save/sources.ts`](../save/sources.ts) before expansion.
- Input and output keys, services and accounts the callee does not have are refused, because
  the server would drop them. Contracts come from [`../save/services.ts`](../save/services.ts).
- Step output keys cannot be indexed or pathed (`flatData[0].col`); `indexedOutputHint` names
  the pattern that works (bind the list, then read it in an echo step).
- New custom code is stored plain (unless the source is itself valid base64); new SQL is
  stored plain with `encodingType` `NONE`.

Tests: `save-v2-overlay.test.ts` (round trip over the real V2 bodies), `save-structural.test.ts`,
`author-commands.test.ts`, `compact-format.test.ts` in
[`../../tests/unit`](../../tests/unit/README.md).

Up: [`../README.md`](../README.md)
