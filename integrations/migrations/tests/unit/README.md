# migrations/tests/unit

| File | Covers |
|---|---|
| `jenkins-client.test.ts` | Jenkins client error shape (no HTML or crumb in messages), build 404, queue deadline, crumb failures |
| `real-jenkins.test.ts` | Client and console parser replayed over the sanitized captures in `../fixtures/real/` |
| `run-args.test.ts` | `migrate run` flag parsing (unknown flags, did-you-mean), profile ↔ env consistency, `status` / `logs` / `profiles` args |
| `profiles-cache.test.ts` | Profile cache TTL and the single re-fetch on a cache miss |
| `preflight.test.ts` | Pre-flight: skip warnings, PD draft → published swap, auth failures, env restore; confirmation gate of a faked end-to-end `run` |
| `run-safety.test.ts` | AD id checks, module / migration-id flags, `--client` vs profile, build reference on every failure after the trigger |

New tests follow the same pattern: `withTempEnvConfig` / `fakeFetch` / `respond` from
`@belzabar/core/testing`, one `describe` per behaviour.
