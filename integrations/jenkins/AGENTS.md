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
│   ├── client.ts      getJobParameters, triggerBuild, resolveQueueItem, getBuild,
│   │                  getConsoleChunk, getFullConsole, buildUrl, jobUrl
│   ├── stream.ts      Progressive console tail until the build completes
│   ├── types.ts       Wire types (JenkinsParameterDefinition, TriggerBuildInput, QueueItem,
│   │                  BuildInfo, ConsoleChunk)
│   ├── constants.ts   Poll intervals and the default stream timeout
│   └── index.ts       Barrel (package entry point)
└── package.json       depends on @belzabar/core only
```

Tests live with the consumer: `integrations/migrations/tests/unit/real-jenkins.test.ts`
replays sanitized captures through this client via `fakeFetch`.

Error codes keep their historical `MIGRATE_JENKINS_*` names (they surface in
`belz migrate` envelopes).
