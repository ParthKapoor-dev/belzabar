# apps/cli/tests/live

Opt-in suites that run the real CLI against one configured environment. Skipped unless
`WI_IMPL_LIVE` is set; the variables and guards are described in
[`packages/core/src/testing/`](../../../../packages/core/src/testing/README.md#live-suites).
Runs use a tmp copy of `~/.wi-impl`, so the real home is only read.

| File | Suite |
|------|-------|
| `read-only.live.test.ts` | Read-only smoke (`envs`, AD reads; `WI_IMPL_LIVE_METHOD` enables the history/show smokes) |
| `ad-lifecycle.live-write.test.ts` | Full AD method lifecycle: create → validate / lint → save → test → test cases → publish → state → history → delete, in `WI_IMPL_LIVE_CATEGORY` only, `belz_tst_` names |
| `pd-page.live-write.test.ts` | PD page writes on one dedicated scratch page (`WI_IMPL_LIVE_PD_PAGE=<draftId>`): save, lock, publish without a host, restore; `afterAll` puts the original draft back and re-publishes |
| [`support/`](./support/README.md) | Cleanup helper spawned by the write suite |

```bash
WI_IMPL_LIVE=<env> bun test apps/cli/tests/live
WI_IMPL_LIVE=<env> WI_IMPL_LIVE_WRITE=1 WI_IMPL_LIVE_CATEGORY=<name> WI_IMPL_LIVE_CATEGORY_ID=<id> bun test apps/cli/tests/live
WI_IMPL_LIVE=<env> WI_IMPL_LIVE_WRITE=1 WI_IMPL_LIVE_PD_PAGE=<draftId> … bun test apps/cli/tests/live/pd-page.live-write.test.ts
```

Every created object is registered with `registerLiveResource` as soon as it exists and cleaned
up in `afterAll`.

Up: [tests](../README.md).
