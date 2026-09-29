# Jenkins client (`@belzabar/jenkins`) — Maintainer Agent

A small Jenkins REST client (basic auth, CSRF crumbs, build trigger, queue
resolution, build info, progressive console streaming). `@belzabar/migrations`
is its only consumer and re-exports it from `integrations/migrations/lib/index.ts`.
It has no commands and no registry; the package's only export is `.` (`lib/index.ts`).
Credentials come from core `Config.getJenkins()` (see `integrations/migrations/AGENTS.md`).

## Layout

```
jenkins/
├── lib/
│   ├── auth.ts        JenkinsAuth, buildHeaders (UTF-8 basic auth), assertJenkinsAuth (from
│   │                  Config.getJenkins(); job defaults to core DEFAULT_JENKINS_JOB)
│   ├── crumb.ts       CSRF crumb fetch + per-process cache
│   ├── client.ts      jenkinsFetch, jenkinsError, getJobParameters, triggerBuild,
│   │                  resolveQueueItem, getBuild, getConsoleChunk, getFullConsole, buildUrl, jobUrl
│   ├── stream.ts      streamConsole — progressive console tail until the build completes
│   ├── types.ts       Wire types (JenkinsParameterDefinition, TriggerBuildInput, QueueItem,
│   │                  BuildInfo, ConsoleChunk)
│   ├── constants.ts   Poll intervals, queue deadline (10 min), default stream timeout
│   └── index.ts       Barrel (package entry point)
└── package.json       depends on @belzabar/core only
```

Tests: `tests/client.test.ts` (error mapping, queue deadline, crumb errors, auth header) and, with the
consumer, `integrations/migrations/tests/unit/real-jenkins.test.ts` (sanitized captures via
`fakeFetch`).

Every request goes through core `httpRequest` (timeout, IPv4 pin + eviction) via
`jenkinsFetch`. Errors never include the HTML error page or the CSRF crumb: `jenkinsError`
keeps the status + page `<title>` only. A build 404 is `Build #n not found`
(`MIGRATE_JENKINS_BUILD_NOT_FOUND`); a crumb failure is `MIGRATE_JENKINS_CRUMB_FAILED`;
`resolveQueueItem` gives up after `timeoutMs` (default `QUEUE_TIMEOUT_MS`) with
`JENKINS_QUEUE_TIMEOUT`.

Error codes keep their historical `MIGRATE_JENKINS_*` names (they surface in `belz migrate`
envelopes): `CONFIG_MISSING`, `CRUMB_FAILED`, `PARAMS_FAILED`, `TRIGGER_FAILED`,
`NO_QUEUE_LOCATION`, `QUEUE_READ_FAILED`, `QUEUE_CANCELLED`, `BUILD_NOT_FOUND`,
`BUILD_READ_FAILED`, `CONSOLE_READ_FAILED`, `TIMEOUT` — plus the unprefixed
`JENKINS_QUEUE_TIMEOUT`.

To add an endpoint: a function in `lib/client.ts` on `jenkinsFetch` + `jenkinsError`, a wire type
in `lib/types.ts`, and a `fakeFetch` test in `tests/client.test.ts`.
