# core/src/output

Output shaping shared by read commands.

| File | Contents |
|------|----------|
| `fields.ts` | The `--fields a,b\|all` convention: `parseFieldList` (→ `FieldSelection`; unknown names → `INVALID_VALUE` listing the known ones), `projectRow` (default columns / picked / full row), `pickFields`, `isEmptyValue` |

A command defines its compact default row and the full row; `--fields` picks named fields,
`--fields all` returns the full row. Empty values (`null`, `""`, `[]`, `{}`) are dropped from
projected rows; `false` and `0` are kept. Used by the AD finder/listing commands and `pd show`.

Tests: `packages/core/tests/output-fields.test.ts`. Up: [src](../README.md).
