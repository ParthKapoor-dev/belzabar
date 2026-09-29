# migrations/lib/jenkins

Minimal Jenkins REST client for the migration job: basic auth, CSRF crumbs, build trigger,
queue resolution, build info and progressive console streaming. Re-exported by
`lib/index.ts`, so callers import it from `@belzabar/migrations`.

| File | Contents |
|---|---|
| `auth.ts` | `JenkinsAuth`, `assertJenkinsAuth` (config → auth; `MIGRATE_JENKINS_CONFIG_MISSING`), `buildHeaders` (UTF-8 basic auth) |
| `crumb.ts` | `fetchCrumb` — crumb plus its session cookie, cached per process; 404 means crumbs are disabled |
| `client.ts` | `getJobParameters`, `triggerBuild`, `resolveQueueItem`, `getBuild`, `getConsoleChunk`, `getFullConsole`, `buildUrl`, `jobUrl`; private `jenkinsFetch` / `jenkinsError` |
| `stream.ts` | `streamConsole` — polls `progressiveText` until the build stops, calling `onChunk` |
| `constants.ts` | Poll intervals (2 s), queue deadline (10 min), stream timeout (1 h) |
| `types.ts` | Wire types: parameter definitions, trigger input, queue item, build info, console chunk |
| `index.ts` | Barrel |

## Contracts

- Every request goes through core `httpRequest` (timeout, IPv4 pin) via `jenkinsFetch`.
- A folder job (`a/b`) becomes `job/a/job/b`.
- The crumb is bound to the session cookie of the response that issued it; `triggerBuild`
  replays both.
- Error messages never carry the HTML error page or the crumb: `jenkinsError` keeps the status
  and a short, redacted body summary.
- Error codes (historical `MIGRATE_JENKINS_*` names): `CONFIG_MISSING`, `CRUMB_FAILED`,
  `PARAMS_FAILED`, `TRIGGER_FAILED`, `NO_QUEUE_LOCATION`, `QUEUE_READ_FAILED`,
  `QUEUE_CANCELLED`, `BUILD_NOT_FOUND` (message `Build #n not found`), `BUILD_READ_FAILED`,
  `CONSOLE_READ_FAILED`, `TIMEOUT`, `NO_PROFILE_PARAM` (raised in `lib/profiles.ts`); plus
  `JENKINS_QUEUE_TIMEOUT` when `resolveQueueItem` passes its deadline and `MIGRATE_ABORTED`
  when a stream's signal fires.

## Adding an endpoint

1. A function in `client.ts` built on `jenkinsFetch` + `jenkinsError`.
2. Its wire type in `types.ts`.
3. A `fakeFetch` test in `tests/unit/jenkins-client.test.ts`; if a real capture helps, add it
   with `bun scripts/fixtures/capture.ts jenkins` and replay it in `real-jenkins.test.ts`.
