# `lib/validator/rules/`: validator rules

Each rule is a pure `Rule` (`(page, ctx) → ValidationIssue[]`, type in
[`../context.ts`](../context.ts)) that builds issues with `issue(code, …)` from
[`../catalogue.ts`](../catalogue.ts). `validateHydrated` runs the three lists in order.

| File | List | What it checks |
|---|---|---|
| `existing.ts` | `EXISTING_RULES` | Core page rules: invalid JSON, orphan bindings, unused variables, form field `props`, `children` object, tables, invalid components, HTTP-call basics |
| `invariants.ts` | `INVARIANT_RULES` | Configs the PD runtime renders blank, invisible or not at all: root layout, duplicate ids, phone field, derived var in innerHTML, array `initialValue`, button `[className]`, raw HTML form elements; `isStyleOnlySymbol` |
| `lint.ts` | `LINT_RULES` | Review-checklist and design-import lint (structure, bindings, HTTP, accessibility, tables, CSS); every one fires on real pages, so all are warnings |

Codes keep an external short name (`V1`, `T1`–`T6`, `C5`, `R1`, `H1`, `F1`, `U1`) where the rule
means the same as the design-import checker; wi-impl-only rules use `UPPER_SNAKE` names. The
catalogue's `source` records the origin. How to add a rule: [`../README.md`](../README.md#adding-a-rule).
