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
3. **PD page/component links** — Extract published IDs
4. **SQL changes** — Any DDL/DML changes to database schema
5. **Impacted frontend routes/components** — If PD changes were made

If the user provides AD URLs, use `belz ad show <uuid> --llm` to fetch method names and categories automatically. If the user provides PD URLs, use `belz pd show <input> --llm` to fetch page/component details.

## STRICT OUTPUT FORMAT

Always output EXACTLY this structure — no extra text, no explanations, no markdown headers. Just the Dev Note block:

```
Summary of change: <one-line summary>

Service category: <value or N/A>

Method name: <value OR markdown links>

Previous service version: <value or N/A>

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

### Method name

- If URLs are available, use inline markdown links: `[method1](url1), [method2](url2)`
- If no URLs: `method1, method2`
- Maintain order, use exact method names

### Previous service version

- Use `N/A` unless the user specifies a version number

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

| Change Type | Service  | Method   | Impact   | AD IDs   | PD IDs   |
|-------------|----------|----------|----------|----------|----------|
| AD only     | Required | Required | N/A      | Required | Omit     |
| PD only     | N/A      | N/A      | Required | Omit     | Required |
| Both        | Required | Required | Required | Required | Required |
| DB only     | N/A      | N/A      | N/A      | Omit     | Omit     |

## Process

1. Identify change type (AD / PD / DB / combo)
2. If AD URLs given, fetch method details with `belz ad show`
3. If PD URLs given, fetch page/component details with `belz pd show`
4. Extract and deduplicate all IDs
5. Convert links to inline markdown
6. Write explicit 1-line summary
7. Apply strict formatting
8. Output ONLY the Dev Note — nothing else before or after

## Examples

### Backend (AD) Example

```
Summary of change: Updated filter input to use default value `[]` in reportById.generate step 3.

Service category: NSM.Reporting

Method name: [reportById.generate](https://nsm-dev.nc.verifi.dev/automation-designer/NSM.Reporting/41c40f512bffaf3c1e6ab2ef8c16fd0a)

Previous service version: N/A

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

Method name: N/A

Previous service version: N/A

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

Method name: [LT262.archive](https://nsm-dev.nc.verifi.dev/automation-designer/NSM.Staff/abc123)

Previous service version: N/A

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
