# ad run-suites

Runs every local regression suite in `./suites/*.spec.json` (written by
`belz ad save-suite`) against the chosen env.

```bash
belz ad run-suites --env <env>
```

For each suite, the command:
1. Fetches the method (the saved uuid).
2. Injects the saved input values.
3. Posts the same `/chain/test` body that `belz ad test` sends
   (`lib/payload-builder.ts:buildV1TestPayload`).
4. Checks for HTTP 200 and a non-failed execution. A failure reports the server's
   message.

Output values are not asserted. For that, use `belz ad test --expect` or the
server-side test cases (`belz ad test-case`).

The suites really execute (SQL and HTTP steps run), so the command declares `writes`
and needs an explicit `--env`.

A suite saved on another env (`env` field) is not run (ENV_MISMATCH). A legacy suite
with no `env` is not run either (ENV_MISSING): its bare uuid could belong to any env.
Pass `--legacy-env <env>` equal to `--env` to run such suites as that env's, or
re-save them with `belz ad save-suite`.
