# `lib/validator/`: the PD validator

Static checks over a `HydratedPage`: renderer invariants that crash or blank a page, binding
and variable consistency, and the mechanical parts of a PD review checklist. Used by
`validate`, `preflight`, `save`, `publish`, `history show/restore` and `show`.

## In this directory

| Path | What it is |
|---|---|
| `catalogue.ts` | `PD_RULES`: every code with its severity, source and `escalate` flag; `issue(code, …)` builds an issue |
| `index.ts` | `validateHydrated(page)` (every rule) and `validateEdit(before, after)` (the diff-aware edit gate); `partitionBySeverity` |
| `context.ts` | `buildRuleContext`: binding references, defined names and usage, computed once per page |
| `recursive.ts` | `validateRecursive` (`validate --recursive`) and the page ↔ symbol checks (`SYMBOL_*`) |
| [`rules/`](./rules/README.md) | The rule functions |

## Contracts

- **The catalogue is the only place severities live.** Rules create issues with `issue(code,
  …)`, so an uncatalogued code does not compile. `commands/lint/help.txt` lists the same
  codes; `tests/unit/validator-lint.test.ts` keeps them in sync.
- **Calibration: real editor output has 0 errors** (`tests/unit/validator-real.test.ts` over
  `tests/fixtures/real/`). A rule that fires on real, working pages is a warning; mark it
  `escalate` if an edit that introduces it should block.
- **Diff-aware gate.** `validateEdit` fingerprints issues by code, node id, path and message:
  an issue already on `before` is `preExisting` and downgraded to a warning; a new one is
  `introduced`, and an `escalate` code becomes an error. So messages must not embed shifting
  positions (name HTTP calls by `callId`, nodes by id), or old issues look new.
- **Binding roots.** `{%a.b[0].c%}` refers to variable `a`. Defined names come from
  `userDefined`, `derived`, `variables.generated` and a component's `inputs`; `$item`, `$row`,
  `$event`, `$$…`, `pageContext` and `ref` are runtime roots. Bindings that occur only inside
  `variables.generated` (editor-built form configs) are warnings; bindings inside JS comments of
  code bodies are ignored. A layout-less component with `styles` is a style-only symbol.
- **Recursive.** Symbols are the DRAFT components with the instance's exact name, fetched
  through the page cache and validated once each; `SYMBOL_NESTING_DEPTH` fires past 3 levels.

## Output

`validate` reports `data.issues` (errors) and `data.warnings` as `{CODE: {count, refs}}`;
`--full` gives the flat list, `--summary` drops the refs.

## Not checkable statically

Runtime or data-dependent failures wi-impl cannot gate: a radio `exp-form-field` without
`[options]` data (renders 0 height), a select `labelKey`/`valueKey` that does not match the API
response, and Angular Material tab-switch console errors (harmless).

## Adding a rule

1. Write it in the fitting `rules/*.ts` file as a `(page, ctx) → ValidationIssue[]` function and
   add it to that file's rule list.
2. Catalogue its code in `catalogue.ts` and list it in `commands/lint/help.txt`.
3. Add positive and negative cases (`validator.test.ts` or `validator-lint.test.ts`) and keep
   `validator-real.test.ts` at 0 errors.

Up: [`../README.md`](../README.md).
