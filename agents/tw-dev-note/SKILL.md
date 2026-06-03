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

Always output EXACTLY this structure — no extra text, no explanations, no markdown headers. Just the Dev Note block:

```
Summary of change: <one-line summary>

Service category: <value or N/A>

Method names & Version changes:
<method line 1>
<method line 2>
...

Was dev-testing done? Yes

Were unit test cases added? No

Impacted areas and services: <route/component in backticks OR N/A>

AD (Published Id): `<comma-separated ids>` (only include this line if AD changes exist)

PD (Published Id): `<comma-separated ids>` (only include this line if PD changes exist)

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
- `N/A` (PD-only changes)

### Method names & Version changes

- **One method per line** — never comma-separated. Reviewers scan vertically.
- Format per line: `<method-name-or-link> (v<previous> -> v<new>)`
  - With URL: `[LT264.issue](https://nsm-dev.nc.verifi.dev/automation-designer/NSM.Staff/473e75bf1a6c526e65cdbe2a45d87faa) (v14 -> v17)`
  - Without URL: `LT264.issue (v14 -> v17)`
- The version pair MUST be the **published** version on the prior release vs.
  the **published** version this change introduces — not draft/working versions.
  Pull `summary.version` from `belz ad show <uuid> --llm` on the relevant env;
  the previous published version is in `belz ad changelog <uuid> --llm`.
- If the change touches multiple methods, list each on its own line (including
  duplicates if the same method was published twice in the scope of this task —
  e.g. an interim bump followed by a final fix; collapse to one line if only
  the final version matters to reviewers).
- If the previous version is genuinely unknown and the user does not supply it,
  use `(v? -> v<new>)` rather than omitting — making the gap visible is better
  than hiding it.
- Maintain caller-supplied order; use exact method names.

### Impacted areas and services

- ONLY route paths or component names, always in backticks
- No explanation text
- Backend-only changes: `N/A`

### AD / PD (Published Id)

- Extract IDs from URLs (the last path segment)
- Comma-separated, no spaces, inside backticks
- No duplicates
- Only include the line if that type of change exists

### Database schema

- Default: `No changes.`
- If SQL provided, include as a fenced code block

## Classification Logic

| Change Type | Service  | Methods+Versions | Impact   | AD IDs   | PD IDs   |
|-------------|----------|------------------|----------|----------|----------|
| AD only     | Required | Required         | N/A      | Required | Omit     |
| PD only     | N/A      | N/A              | Required | Omit     | Required |
| Both        | Required | Required         | Required | Required | Required |
| DB only     | N/A      | N/A              | N/A      | Omit     | Omit     |

## Process

1. Identify change type (AD / PD / DB / combo)
2. If AD URLs given, fetch method details with `belz ad show <uuid> --llm`
3. **For every AD method, also resolve its published version pair** —
   `summary.version` from `belz ad show` is the *new* version; the previous
   one is the latest entry before that in `belz ad changelog <uuid> --llm`.
   If the user supplied the pair explicitly, trust them.
4. If PD URLs given, fetch page/component details with `belz pd show`
5. Extract and deduplicate all IDs
6. Convert links to inline markdown
7. Write explicit 1-line summary
8. Apply strict formatting (one method per line in the Methods & Version block)
9. Output ONLY the Dev Note — nothing else before or after

## Examples

### Backend (AD) Example

```
Summary of change: Updated filter input to use default value `[]` in reportById.generate step 3.

Service category: NSM.Reporting

Method names & Version changes:
[reportById.generate](https://nsm-dev.nc.verifi.dev/automation-designer/NSM.Reporting/41c40f512bffaf3c1e6ab2ef8c16fd0a) (v22 -> v23)

Was dev-testing done? Yes

Were unit test cases added? No

Impacted areas and services: N/A

AD (Published Id): `41c40f512bffaf3c1e6ab2ef8c16fd0a`

Mention any changes in database schema: No changes.
```

### Frontend (PD) Example

```
Summary of change: Updated dropdown options to include `PayIt` entityId in LT-260 submission form.

Service category: N/A

Method names & Version changes: N/A

Was dev-testing done? Yes

Were unit test cases added? No

Impacted areas and services: `/ncdot-notice-and-storage/lt-260-submission`

PD (Published Id): `4e29e226d50a63462da5b9a79f2406e2`

Mention any changes in database schema: No changes.
```

### Combined (AD + PD + DB) Example

```
Summary of change: Added `is_archived` column to `application` table, updated LT262.archive method to set `is_archived = true`, and hid archived rows in LT-262 list page.

Service category: NSM.Staff

Method names & Version changes:
[LT262.archive](https://nsm-dev.nc.verifi.dev/automation-designer/NSM.Staff/abc123) (v8 -> v9)

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
