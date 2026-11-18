# migrations/tests/unit

| File | Covers |
|---|---|
| `jenkins-client.test.ts` | Jenkins client error shape (no HTML or crumb in messages), build 404, queue deadline, crumb failures |
| `real-jenkins.test.ts` | Client and console parser replayed over the sanitized captures in `../fixtures/real/` |
| `run-args.test.ts` | `migrate run` flag parsing (unknown flags, did-you-mean), profile ↔ env consistency, `status` / `logs` / `profiles` args |
| `profiles-cache.test.ts` | Profile cache TTL and the single re-fetch on a cache miss |
| `preflight.test.ts` | Pre-flight: skip warnings, PD draft → published swap, auth failures, env restore; confirmation gate of a faked end-to-end `run` |
| `run-outcome.test.ts` | Same-version skips (console derived from the build-1904 capture), `data.outcome`, warnings, `--strict`; target-env cache eviction (local, and the repeated server clear) |
| `run-failure.test.ts` | A FAILED entity fails the run, its reason read through a status build (captures 2446/2447); background mode (capture 2789): target polled, landed ids reported and cleared, `BACKGROUND` when it cannot check |
| `run-safety.test.ts` | AD id checks, module / migration-id flags, `--client` vs profile, build reference on every failure after the trigger |

New tests follow the same pattern: `withTempEnvConfig` / `fakeFetch` / `respond` from
`@belzabar/core/testing`, one `describe` per behaviour.
