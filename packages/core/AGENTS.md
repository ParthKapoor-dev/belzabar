# AGENTS.md — @belzabar/core

Docs: [`README.md`](./README.md) (package, exports, error codes) and the README in each
`src/*` directory. Read the one for the module you touch before changing it.

## Rules

- **Downstream impact.** Every integration and `apps/cli` depend on this package. Before changing
  a public export, check its usages across `integrations/*` and `apps/cli`, run `bun run check`
  from the repo root, and build once (`bun run belz:build`) if you touched the runner or stdio.
- **Public contracts; do not break them:** `CommandModule`, `ok` / `fail` / `failWithData`,
  `CliError`, error codes (renaming one is a breaking change), and `EnvelopeSchema`. Change the
  schema and the runner together; `apps/cli/tests/envelope-contract.test.ts` and
  `envelope-success.test.ts` check every command against it.
- **Runner code never calls a bare `process.exit()` after output**; use `flushAndExit`, or
  piped output past 64 KiB is lost.
- **Read the process env only through `trustedBelzEnv()`** (a cwd `.env` must not steer wi-impl).
- **Anything logged, cached or put in `error.details` goes through `redactSecrets`.**
- Do not "simplify" `prepareIpv4Fetch` into a throw on resolution failure (see `src/http/README.md`).
- `@belzabar/core/testing` is test-only; runtime code never imports it. Test seams in runtime
  code (`reloadConfig`, `setIpv4ResolverForTesting`) are for tests only.
- Tests never touch the real `~/.wi-impl`: rely on the preload and `withTempEnvConfig`; no
  `mock.module`.
- Generic helpers go in `src/`; Expertly-specific code shared by AD and PD goes in `src/platform/`.

## When you change something

Update the README of the directory you changed (new exports, changed behaviour, new files) in
the same commit, and this file only if an agent rule changed.
