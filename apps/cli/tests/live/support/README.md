# apps/cli/tests/live/support

Helpers for the live write suites; never imported by the CLI.

| File | Role |
|------|------|
| `soft-delete.ts` | `bun soft-delete.ts <uuid>…` → one JSON line `[{uuid, result, name?}]`. Soft-deletes `wi_impl_tst_` (or pre-rename `belz_tst_`) methods, including published copies that `wi-impl ad delete` refuses by design. Spawned by the lifecycle suite's `afterAll` with `WI_IMPL_HOME` set to the seeded live home |

Guards (fail closed): only the `WI_IMPL_LIVE` env; the method must be named `wi_impl_tst_…` (or `belz_tst_…`) and sit in
chain category `WI_IMPL_LIVE_CATEGORY_ID`. A uuid already reported as `METHOD_NOT_FOUND` counts as
gone.

Up: [live](../README.md).
