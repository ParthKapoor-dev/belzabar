# lib/types — method types

| File | Contents |
|---|---|
| `common.ts` | The version-neutral model: `ApiVersion`, `MethodState`, `MethodField`, `MethodOutput`, `StepInput`, the `ParsedStep` union (`CUSTOM_CODE`, `SPEL_ECHO`, `SQL`, `REDIS_*`, `EXISTING_SERVICE`, `UNKNOWN`) and `HydratedMethod`. |
| `v1-wire.ts` | Raw V1 shapes (`V1RawMethodResponse`, `V1ServiceStep`, `V1Mapping`, `V1AutomationDefinition`, …). |
| `v2-wire.ts` | Raw V2 shapes (`V2MethodResponse`, `V2MethodBody`, `V2Step`, …). |

## Rule

Code that reads a method works on `common.ts`. Only code that handles a raw body imports the
wire files: the parsers, the API clients, save/serialize, the validator, SQL payloads,
fingerprinting, and the commands that take a raw body (`create`, `import`, `show <file>`).

Adding a field: if both wires carry it (maybe under different names), add it to `common.ts`
and map it in both parsers. If only one wire has it, leave it in the step's `raw` and read it
there.

Up: [`../README.md`](../README.md)
