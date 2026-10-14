# core/src/http

The one HTTP stack for everything belz talks to: the Expertly platform (AD/PD), Teamwork and
Jenkins. Timeouts, retries, sessions, error mapping and redaction live here so integrations
never hand-roll them.

## What's here

| File | Contents |
|------|----------|
| `transport.ts` | `httpRequest` (timeouts, IPv4 pinning, safe retry), `defaultTimeoutMs`, `resolveTimeoutMs`, `isConnectPhaseError`, `singleFlight`, `createLimiter`, `sleep`, `isReplayableBody` |
| `api.ts` | `apiFetch`: authenticated Expertly client |
| `auth.ts` | Per-env sessions: `login`, `ensureSession`, `refreshSession`, `loadSession`, `jwtExpiry`, `isTokenExpired` |
| `errors.ts` | Response → `CliError`: `httpError`, `apiError`, `ensureApiOk`, `expectJson`, `readJsonOrNull`, `expectFound`, `badJsonError`; safe bodies `summarizeBody`, `readBodySummary`, `readErrorBody` |
| `redact.ts` | `redactSecrets`, `redactString`, `REDACTED` |
| `dns.ts` | `prepareIpv4Fetch`, `evictIpv4Cache`, `setIpv4ResolverForTesting` (test seam) |
| `index.ts` | Re-exports all of the above |

## Data flow

```
integration → apiFetch(path) → ensureSession → httpRequest(url) → prepareIpv4Fetch → fetch
                     ↑ 401: one shared refreshSession + one retry
```

## apiFetch

`apiFetch(path, {authMode?, timeoutMs?, ...RequestInit})` resolves with the `Response`; callers
map errors themselves. It sends the env session token (`Bearer` or `Raw`; the
`"Expertly-Auth-Token": "true"` header is replaced by the token), logs in once per process
(single-flight), and on 401 does one shared refresh and one retry (FormData is re-sent; a
stream body fails with `AUTH_EXPIRED`). A second 401 after re-login is `AUTH_FAILED`. The
refresh is announced through `lifecycle.notice`. No Content-Type is sent on GET.

Sessions live in `sessions/<env>.json` (0600). Login uses the read timeout. Errors:
`AUTH_MISSING_CREDENTIALS`, `AUTH_FAILED`, `AUTH_NO_TOKEN`.

## httpRequest: timeouts and retries

- Default timeout: 60 s for GET/HEAD/OPTIONS, **300 s for every other method**.
  `WI_IMPL_HTTP_TIMEOUT_MS` sets both; `WI_IMPL_HTTP_WRITE_TIMEOUT_MS` overrides non-GET. Per call:
  `timeoutMs: <ms>`, or `0` / `"none"` for streams and long server-side runs.
- The timeout covers the response headers, then applies again as an idle deadline on each
  body chunk: a body that stalls mid-read rejects `res.text()` / `json()` with `HTTP_TIMEOUT`
  (`details.phase: "body"`). The timeout is raced, so it fires even if fetch ignores the abort.
- A timed-out non-GET carries `details.mayHaveCompleted: true, retryable: false`, says the
  operation may still complete on the server, and is **never** retried.
- Network failure → `HTTP_NETWORK_ERROR` (`details: {method, connectPhase, mayHaveCompleted,
  retryable}`). A failure on the pinned IP evicts the pin and retries once by hostname only
  when nothing was sent (connect phase) or the method is a read.
- Use `httpRequest` directly for non-Expertly hosts (Teamwork, Jenkins).

## IPv4 pinning (`dns.ts`)

Bun's `fetch` has no happy-eyeballs, so a host that advertises AAAA over a black-holed IPv6
path hangs on a SYN that never completes. `prepareIpv4Fetch` resolves IPv4 itself and rewrites
the URL to the IP, keeping `Host` and TLS SNI.

That makes the A-record query load-bearing, and flaky resolvers often refuse or time out on
exactly that query. So `dns.ts` resolves through both `resolve4()` and `lookup()`, retries
with backoff, and caches to `~/.wi-impl/cache/dns.json` (a disk cache, because the CLI is a
short-lived process). If resolution fails outright it returns the original hostname URL
rather than throwing: a request that might hang beats a command that cannot run.

## Errors and redaction

- `httpError(res, opts)`: 404 → `NOT_FOUND` (or `notFoundCode`), else `HTTP_<status>` (or
  `<codePrefix>_<status>`). `expectJson` also treats a 2xx with an empty or `null` body as not
  found. `readJsonOrNull` / `expectJson` take `badJson(text, res)` to replace `HTTP_BAD_JSON`.
- `apiError(res, {code, message?, path?})` / `ensureApiOk`: the integrations' non-OK error, with
  a namespace code (a string or `(status) => code`) and `details: {path?, status, body}`.
- Bodies in messages are summarised (`HTML page: <title>`, truncated, redacted);
  `readErrorBody` keeps small JSON structured.
- `redactSecrets(value, {keys?})` scrubs Authorization / auth-token headers, cookies, JWTs,
  password fields and secret query/form pairs (`token=`, `access_token=`, `j_password=`,
  `api_key=`, `client_secret=`, `crumb=`, …). Use it on anything logged, cached or put in
  `error.details`; `{keys: "headers"}` drops only header-like keys. `vlog` redacts
  automatically.

Tests: `packages/core/tests/http.test.ts`, `testing-helpers.test.ts`. Up: [src](../README.md).
