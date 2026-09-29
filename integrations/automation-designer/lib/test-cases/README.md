# lib/test-cases — expectations, test cases and suites

Output expectations for `ad test --expect`, and the persisted test cases behind
`ad test-case` (export, sync, run).

| File | Contents |
|---|---|
| `expect.ts` | `--expect` parsing and evaluation (`parseExpectation`, `evaluateExpectations`) and the conversion to and from stored assertions. |
| `case-file.ts` | The UI wire encoding ↔ a git-friendly case file (`caseFromWire`, `caseToWire`, `diffCases`, `serializeCaseFile`, `caseFileName`). |
| `files.ts` | The on-disk export layout (`methodDirFor`, `readMethodMeta`, `readCaseFiles`, `writeMethodDir`). |
| `suite.ts` | A method's suite as case files (`fetchSuite`), contract checks against the method's inputs and outputs, verified writes (`createCase`, `updateCase`), and `planSync` / `applySync`. |
| `run-suite.ts` | `runSuiteCases`: `test-case run-suite --wait`, one `/chain/test` run per active case, assertions evaluated locally. |

Related: [`../test-run.ts`](../test-run.ts) runs one inline test and returns the outputs map;
[`../test-suite.ts`](../test-suite.ts) summarises a suite for `test-cases` and `test-case list`.

## `--expect`

- Operators: `out=v`, `out!=v`, `out~=v` (contains), `out>v`, `out<v`, `out>=v`, `out<=v`.
- `out.a[0].b=v` looks inside an output that holds JSON.
- The right-hand side is JSON when it parses, otherwise text; quote it to force a string.
  Every test output arrives as text, so `"42"` equals `42`.
- Any failure exits 1 with `AD_TEST_EXPECTATION_FAILED`.

Stored assertions are the UI's advance-mode SpEL (`#{out} eq 'v'`), which only knows eq, neq,
gt, lt and contains, and no paths.

## Case files and the export layout

```
<root>/<Category>/<method>/
  method.json        {name, category, uuids: {<env>: <chainUuid>}, inputs: {key: type}, outputs: [key]}
  cases/<case>.json  {name, description, inputs{fieldCode: value}, inputExtras?, assertions[{output, op, expected} | {expression}]}
```

Case files carry no ids and no env, so one directory syncs to several envs (`sync --env X`
uses `uuids[X]`). Keys are written in a stable order. `sync` builds a plan and applies it only
with `--apply`.

## Platform facts

- A method without a suite: the suite GET answers 200 with an empty body (belz: no suite,
  0 cases). The first `POST /chain/testcases/{uuid}` creates the suite.
- `POST` stores every field. `PUT` replaces only inputs and assertions and silently keeps
  name, description and active.
- `DELETE` is soft and the name stays reserved (`AD_TESTCASE_NAME_RESERVED`).
- The bulk route rejects the documented body shape, so `bulk` creates cases one at a time.
- Stored input values are JSON text of a `{"value": …}` wrapper and come back re-spaced:
  compare decoded, never bytes.
- The server's own suite run is not observable: `testsuite/execute` returns at once,
  `testsuite/report` is not per chain, and the suite status does not reflect failing
  assertions. That is why `run-suite --wait` runs the cases itself, like `ad test --case`.

Every write is contract-checked first and verified by reading the suite back.

Up: [`../README.md`](../README.md)
