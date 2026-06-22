---
name: tw-dev-note
description: Generate standardized Teamwork Dev Notes (NDN) from raw engineering change descriptions. Use when user says "NDN", provides AD/PD links, pastes SQL changes, gives rough change descriptions, or asks to create a Dev Note. Produces clean, audit-friendly, production-ready Dev Notes.
---

# Skill: Generate New Dev Note (NDN)

Convert raw engineering change descriptions into **clean, standardized, production-ready Dev Notes** for Teamwork task comments.

> **Not the same as an AD changelog note.** A Teamwork Dev Note (this skill) is the
> human-facing handoff posted as a task comment. The AD *changelog* note — recorded
> by `belz ad publish --note "..."` / `belz ad changelog` — is the per-method audit
> entry on the chain itself. Both should be written when publishing AD changes; they
> are separate artifacts and neither replaces the other.

## Gathering Context

Before generating the Dev Note, gather the necessary information. The user may provide some or all of the following — infer what you can, ask only if critical info is missing:

1. **What changed?** — The raw description of changes made
2. **AD method links/URLs** — Extract category, method name, and published IDs from URLs like `https://nsm-dev.nc.verifi.dev/automation-designer/<Category>/<ID>`
3. **Published version change per AD method** — the version the method was on
   *before* this task vs. the version this task ships. Required for every AD
   method in the dev note. If not supplied: `belz ad show <uuid> --llm` gives
   the current published `summary.version`; `belz ad changelog <uuid> --llm`
   gives the previous one (the entry immediately before the latest publish).
4. **PD page/component links** — Extract published IDs
5. **SQL changes** — Any DDL/DML changes to database schema
6. **Impacted frontend routes/components** — If PD changes were made

If the user provides AD URLs, use `belz ad show <uuid> --llm` to fetch method names, categories, and the current published version; use `belz ad changelog <uuid> --llm` to read the prior published version. If the user provides PD URLs, use `belz pd show <input> --llm` to fetch page/component details.

## STRICT OUTPUT FORMAT

Always output EXACTLY this structure — no extra text, no explanations, no markdown headers. Just the Dev Note block. **Omit any line whose value would be `N/A` or null** (see Field Rules); always keep the dev-testing / unit-test / schema lines.

```
Summary of change: <one-line summary>

Service category: <value>                                    ← omit if N/A

Method names & Version changes:                              ← omit whole block if no AD methods
<method line 1>
<method line 2>
...

PD pages & components:                                       ← omit whole block if no PD entities
<pd line 1>
<pd line 2>
...

Was dev-testing done? Yes

Were unit test cases added? No

Impacted areas and services: <route/component in backticks>  ← omit if no PD routes touched

AD (Published Id): `<comma-separated ids>`                   ← omit if no AD changes

PD (Published Id): `<comma-separated published ids>`         ← omit if no PD changes

Mention any changes in database schema: No changes.
```

## Field Rules

### Summary of change (CRITICAL)

- EXACTLY **one line**
- Must be **explicit** — include exact statuses, field names, logic, conditions
- Preserve exact expressions when important (e.g., SpEL expressions, SQL fragments)
- Never vague — "Updated audit logic" is WRONG; "Updated condition to execute _userActivity.audit only when `#{util.isNotEmpty(changesJSON)}` and `#{util.isEmpty(changesJSON[0].error)}`" is CORRECT

### Service category

Allowed values (comma-separated if multiple):
- `NSM.Staff`
- `NSM.Helpers`
- `NSM.Reporting`
- `NSM.Public`
- `NSM.Templates`

If there are no AD changes (PD-only / DB-only), **omit the `Service category:` line entirely**. Do not print `N/A`.

### Method names & Version changes

- **One method per line** — never comma-separated. Reviewers scan vertically.
- Format per line: `<method-name-or-link> (v<previous> -> v<new>)`
  - With URL: `[LT264.issue](https://nsm-dev.nc.verifi.dev/automation-designer/NSM.Staff/473e75bf1a6c526e65cdbe2a45d87faa) (v14 -> v17)`
  - Without URL: `LT264.issue (v14 -> v17)`
- The version pair MUST be the **published** version on the prior release vs.
  the **published** version this change introduces — not draft/working versions.
  Pull `summary.version` from `belz ad show <uuid> --llm` on the relevant env;
  the previous published version is in `belz ad changelog <uuid> --llm`.
- **Why "published vs published, same env":** every method carries **independent**
  version counters for its draft and its published copy, and those counters reset
  per environment. The draft on `nsm-dev` is on a different version line than the
  published on `nsm-dev`, which is on a different line than the published on
  `nsm-qa`. Comparing a draft version against a published version — or comparing
  versions across envs — tells you nothing. The `(v<prev> -> v<new>)` pair in a
  dev note is **always** published-on-prior-release vs published-on-this-release,
  scoped to the same environment (the env the dev note describes).
- If the change touches multiple methods, list each on its own line (including
  duplicates if the same method was published twice in the scope of this task —
  e.g. an interim bump followed by a final fix; collapse to one line if only
  the final version matters to reviewers).
- If the previous version is genuinely unknown and the user does not supply it,
  use `(v? -> v<new>)` rather than omitting — making the gap visible is better
  than hiding it.
- Maintain caller-supplied order; use exact method names.
- **Omit the whole `Method names & Version changes:` block if there are no AD methods.** Do not print `N/A`.

### PD pages & components

The PD-side mirror of "Method names & Version changes". Show every PD page /
component touched as a markdown link **named with the entity** and **pointing at
the draft id** — so a reviewer clicking the link lands on the page they need
to look at, not on a hex they have to resolve.

- **One entry per line.**
- Format: `[<page-or-component-name>](<env-base-url>/ui-designer/<page|symbol>/<draftId-or-symbol-name>)`
  - Page: `[lt-260-submission](https://nsm-dev.nc.verifi.dev/ui-designer/page/4e29e226d50a63462da5b9a79f2406e2)`
  - Symbol/component (no hex in URL — uses the symbol name): `[n_s_side-bar-nav-link](https://nsm-dev.nc.verifi.dev/ui-designer/symbol/n_s_side-bar-nav-link)`
- **Use the DRAFT id in the URL**, not the published id. A reviewer wants to
  see what was edited — that's the draft view. The published id still goes
  in the `PD (Published Id):` line below, which is the deploy-tooling input.
- Fetch the name + draftId via `belz pd show <input> --llm`; read
  `data.summary.name` and `data.summary.draftId`.
- Omit the whole `PD pages & components:` block if there are no PD entities.

### Impacted areas and services

- ONLY route paths or component names, always in backticks
- No explanation text
- **Omit the line entirely if there are no PD routes touched** (e.g. backend-only changes). Do not print `N/A`.

### AD / PD (Published Id)

- Always list **published** IDs here — these are the deployable IDs the
  migration tooling consumes. (Draft IDs belong in the URLs of the PD pages
  & components block above, not here.)
- Extract published IDs from `belz ad show` / `belz pd show` (`summary.publishedId`)
  or from URLs when the user pastes them — for PD specifically, a URL of the
  form `/ui-designer/page/<hex>` gives you the **draft** id, not the published
  one; resolve via `belz pd show <draft-hex> --llm` and take `summary.publishedId`.
- Comma-separated, no spaces, inside backticks.
- No duplicates.
- Only include the line if that type of change exists.

### Database schema

- Default: `No changes.`
- If SQL provided, include as a fenced code block

## Classification Logic

A cell of "Omit" means the line is left out of the dev note entirely (no `N/A` placeholder).

| Change Type | Service  | Methods+Versions | PD pages | Impact   | AD IDs   | PD IDs   |
|-------------|----------|------------------|----------|----------|----------|----------|
| AD only     | Required | Required         | Omit     | Omit     | Required | Omit     |
| PD only     | Omit     | Omit             | Required | Required | Omit     | Required |
| Both        | Required | Required         | Required | Required | Required | Required |
| DB only     | Omit     | Omit             | Omit     | Omit     | Omit     | Omit     |

## Process

1. Identify change type (AD / PD / DB / combo)
2. If AD URLs given, fetch method details with `belz ad show <uuid> --llm`
3. **For every AD method, also resolve its published version pair** —
   `summary.version` from `belz ad show` is the *new* version; the previous
   one is the latest entry before that in `belz ad changelog <uuid> --llm`.
   If the user supplied the pair explicitly, trust them.
4. If PD URLs given, fetch page/component details with `belz pd show <input> --llm`. Capture `summary.name`, `summary.draftId`, and `summary.publishedId` for every entity.
5. Extract and deduplicate IDs. For PD: keep the **draft id** for the URL in the "PD pages & components" block; keep the **published id** for the "PD (Published Id)" line.
6. Convert links to inline markdown (AD method names → `automation-designer/<cat>/<uuid>` URL; PD names → `ui-designer/page/<draftId>` or `ui-designer/symbol/<name>` URL).
7. Write explicit 1-line summary
8. Apply strict formatting (one entry per line in Method names & Version changes and PD pages & components)
9. **Omit any line whose value would be N/A** (Service category, Impact, AD IDs, PD IDs, the AD/PD block headings). The dev-testing / unit-test / schema lines always stay.
10. Output ONLY the Dev Note — nothing else before or after

## Examples

### Backend (AD) Example

```
Summary of change: Updated filter input to use default value `[]` in reportById.generate step 3.

Service category: NSM.Reporting

Method names & Version changes:
[reportById.generate](https://nsm-dev.nc.verifi.dev/automation-designer/NSM.Reporting/41c40f512bffaf3c1e6ab2ef8c16fd0a) (v22 -> v23)

Was dev-testing done? Yes

Were unit test cases added? No

AD (Published Id): `41c40f512bffaf3c1e6ab2ef8c16fd0a`

Mention any changes in database schema: No changes.
```

### Frontend (PD) Example

```
Summary of change: Updated dropdown options to include `PayIt` entityId in LT-260 submission form.

PD pages & components:
[lt-260-submission](https://nsm-dev.nc.verifi.dev/ui-designer/page/8d12fbc3e74a4a2dab1b1e7e1a9c1d20)

Was dev-testing done? Yes

Were unit test cases added? No

Impacted areas and services: `/ncdot-notice-and-storage/lt-260-submission`

PD (Published Id): `4e29e226d50a63462da5b9a79f2406e2`

Mention any changes in database schema: No changes.
```

Note: `8d12fbc3...` (in the URL) is the **draft** id; `4e29e226...` (in `PD (Published Id)`) is the **published** id. They are different hexes pointing at the same logical page.

### Combined (AD + PD + DB) Example

```
Summary of change: Added `is_archived` column to `application` table, updated LT262.archive method to set `is_archived = true`, and hid archived rows in LT-262 list page.

Service category: NSM.Staff

Method names & Version changes:
[LT262.archive](https://nsm-dev.nc.verifi.dev/automation-designer/NSM.Staff/abc123) (v8 -> v9)

PD pages & components:
[lt-262-list](https://nsm-dev.nc.verifi.dev/ui-designer/page/aabb11cc22dd33ee44ff5566778899aa)

Was dev-testing done? Yes

Were unit test cases added? No

Impacted areas and services: `/ncdot-notice-and-storage/lt-262-list`

AD (Published Id): `abc123`

PD (Published Id): `def456`

Mention any changes in database schema:

```sql
ALTER TABLE application ADD COLUMN is_archived BOOLEAN DEFAULT false;
```
```
