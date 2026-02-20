# NSM.md

## NSM Quick Context

NSM (Notice & Storage System) has two main portal user types:

- `STAFF`: DMV/staff-side users
- `PORTAL`: public/citizen-side users

## Important Rule (Application Origin)

- If an application was created by a `STAFF` user, it is treated as a **Paper** application.
- If an application was created by a `PORTAL` user, it is treated as a **Digital** application.

## Practical Meaning

This rule is used across NSM flows (especially in AD queries and filters) to decide:

- how form type is shown (`Paper` vs `Digital`),
- which timelines/filters to apply,
- and how staff should interpret data during debugging.

## Common Mapping Pattern in AD

A common SQL pattern in NSM methods is:

- `CASE WHEN ap.logged_by IS NULL THEN 'Digital' ELSE 'Paper' END`

This is typically used to derive form type in list/report methods.

## Why This Matters

When investigating bugs, always verify:

1. Who created the application (`STAFF` or `PORTAL`)
2. Whether the screen/query logic expects `Paper` or `Digital`
3. Whether timeline/status/update fields are interpreted differently based on this origin
