# Jenkins client (`@belzabar/jenkins`) — Maintainer Agent

A small Jenkins REST client (basic auth, CSRF crumbs, build trigger, queue
resolution, build info, progressive console streaming). Extracted from
`integrations/migrations/lib/jenkins`; `@belzabar/migrations` is its only
consumer today and re-exports it from its `lib/index.ts`. It has no commands.

## Layout

```
jenkins/
├── lib/
│   ├── auth.ts        JenkinsAuth, buildHeaders, assertJenkinsAuth (from Config.getJenkins())
│   ├── crumb.ts       CSRF crumb fetch + per-process cache
│   ├── client.ts      jenkinsFetch, jenkinsError, getJobParameters, triggerBuild,
│   │                  resolveQueueItem, getBuild, getConsoleChunk, getFullConsole, buildUrl, jobUrl
│   ├── stream.ts      Progressive console tail until the build completes
│   ├── types.ts       Wire types (JenkinsParameterDefinition, TriggerBuildInput, QueueItem,
│   │                  BuildInfo, ConsoleChunk)
│   ├── constants.ts   Poll intervals, queue deadline (10 min), default stream timeout
│   └── index.ts       Barrel (package entry point)
└── package.json       depends on @belzabar/core only
```

Tests: `tests/client.test.ts` (error mapping, queue deadline, crumb errors) and, with the
consumer, `integrations/migrations/tests/unit/real-jenkins.test.ts` (sanitized captures via
`fakeFetch`).

Every request goes through core `httpRequest` (timeout, IPv4 pin + eviction) via
`jenkinsFetch`. Errors never include the HTML error page or the CSRF crumb: `jenkinsError`
keeps the status + page `<title>` only. A build 404 is `Build #n not found`
(`MIGRATE_JENKINS_BUILD_NOT_FOUND`); a crumb failure is `MIGRATE_JENKINS_CRUMB_FAILED`;
`resolveQueueItem` gives up after `timeoutMs` (default `QUEUE_TIMEOUT_MS`) with
`JENKINS_QUEUE_TIMEOUT`.

Error codes keep their historical `MIGRATE_JENKINS_*` names (except the new
`JENKINS_QUEUE_TIMEOUT`) (they surface in
`belz migrate` envelopes).
