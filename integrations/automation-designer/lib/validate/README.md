# lib/validate — the pre-save validator and `ad lint`

Checks a V2 wire body (the `GET /chain/v2/{uuid}` shape, i.e. what the save route POSTs).
Used by `ad validate`, `ad lint`, and the save / create / publish gate
([`../save/validation.ts`](../save/validation.ts)).

| File | Contents |
|---|---|
| `index.ts` | Public API: `validateMethodV2` (L1–L3, offline, pure), `validateOnline` (+ L4), `auditExistingRecord` (a stored record as `ad validate <uuid>` sees it), `alignSteps`. |
| `catalogue.ts` | `RULES`: every rule code with its default severity and layer; `ruleInfo`. |
| `schema.ts` | L1 structure: zod types, server enums, key patterns, required fields. |
| `steps.ts` | L2 per step: custom code (compile-only JS parse), SQL, SpEL values, conditions, loops, encodings. |
| `graph.ts` | L3 reference graph: every `#{root…}` resolves to a method input, a variable, an earlier step's output, or a platform root; dead steps. |
| `spel.ts` | SpEL `#{…}` scanning: blocks, malformed blocks, root identifiers. |
| `online.ts` | L4 (opt-in): callee contracts and service accounts (cached 1 h, env-scoped), and the dry-run compile: the body as a V1 inline test with every step gated off, so nothing executes. |
| `lint.ts` | `LINT_RULES` and `lintMethodV2`: advisory review heuristics, always warnings. |
| `types.ts` | `ValidationFinding`, `ValidationResult`, `Severity`, the `report` callback type. |

## Contracts

- A finding is `{rule, severity, message, path, step?, fix?, evidence?, preexisting?}`; `path` is a JSON path into the V2 body
  (`steps[2].outputs[0].fieldCode`).
- **Diff-aware.** Given `before` (the fetched draft, or the published copy on publish), a
  finding also present in `before` becomes a warning with `preexisting: true`, so a method that
  already breaks a rule stays saveable and only new violations block. `--strict` promotes only
  new warnings.
- **Finding identity** is semantic, not positional: rule + path, with the step index replaced by
  the aligned `before` step (same id, else an in-order match on service/type, which is how a
  draft lines up with its published copy), other array indices replaced by the element's `key`,
  plus the leaf value (or, for SQL / code / template text, the message with step numbers and
  line/column normalised away). A different broken value at the same path is new; an unrelated
  edit elsewhere in the same SQL or code body keeps old findings pre-existing.
- Rule names: codes inherited from the team's own validator (`M1`, `CI1`, `LP3`, …) keep their
  meaning; belz-only rules are `AD-<FAMILY>-nnn`. `CI1` and `DUP1` are warnings because they
  fire on working methods.
- Lint rules (`Q2`–`Q4`, `Q6`, `AD-LINT-001`…) never run on save or publish. `Q3` is
  project-specific and config-driven: `"lint": {"resolverTables": {"<table>": "<resolverFn>"}}`
  in `~/.belz/config.json` (read by `commands/lint`); with none configured it never fires.
- `Q6` (uuid compared as text): a column named `id`, `*_id` or `*uuid` cast to
  `text`/`varchar` and compared (`=`, `<>`, `IN (…)`, either side) to a bound value (`'#{x}'`,
  `#{x}`, `:param`). Postgres `'…'::uuid` accepts upper case, braces and undashed spellings;
  the text comparison silently misses them. Fix: `col = '#{x}'::uuid`. Heuristic on the column
  name, so a genuinely-text id column is a false positive (advisory only). `Q5` is taken by
  the validator's autoformat rule, hence the gap.

- Report Designer datasources (`AD-LINT-011`–`013`) are linted only when the method has a
  `reportColumns` / `reportData` output (the RD contract): exactly one step, no whitespace
  after the SQL (RD's column discovery parses the SQL text and silently falls back to the raw
  outputs), and lower-case input keys (RD fills a filter into the input named like the column
  in lower case). Both platform behaviours were observed on a live env; see
  [`../../../report-designer/README.md`](../../../report-designer/README.md).

## Adding a rule

1. Add the code to `catalogue.ts` (or `LINT_RULES` for an advisory rule).
2. Emit it with `report({rule, message, path, step})` from the right layer.
3. Add a positive and a negative case to `validate-l1` / `validate-rules` / `validate-online`
   (or `lint`) tests. Calibration over the real bodies is pinned in `validate-diff.test.ts` and
   `lint.test.ts`; update the counts deliberately.

Up: [`../README.md`](../README.md)
