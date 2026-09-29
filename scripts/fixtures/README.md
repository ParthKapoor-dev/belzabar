# scripts/fixtures

The wire-fixture tooling: captures real API responses into each package's `tests/fixtures/…`
and keeps everything committed free of secrets and project data. (The fixtures themselves live
in the packages; this directory is code.)

| File | Role |
|------|------|
| `capture.ts` | `bun scripts/fixtures/capture.ts <target> [args]`: capture AD (`ad-v1`, `ad-v2`, `ad-defs`, `ad-categories`, `ad-notfound`, `ad-raw`), PD (`pd`, `pd-search`, `pd-list`), Teamwork (`tw`) and Jenkins (`jenkins`) responses; `resanitize <dir>` re-runs the sanitizer offline. Writes a `manifest.json` per fixture dir |
| `guard.ts` | Read-only guard: captures run against `BELZ_CAPTURE_ENV` only (required, nothing built in) and GET only. Dependency-free so tests can import it |
| `sanitize.ts` | Sanitizer and secret scanner: secret-named keys, JWTs, `Bearer`/`Basic` values, session cookies, e-mails, phones, credential records, person names (deterministic pseudonyms), real hostnames (→ `.example`) and, with `BELZ_SCRUB_TERMS` naming a local term list, project/tenant names. Only string values change; embedded JSON strings are rewritten only when a rule fired inside them |
| `fixtures-secrets.test.ts` | Scans every tracked `fixtures/` dir for secrets and PII and the whole tree for real hostnames (and scrub terms when configured); unit-tests the sanitizer and the guard |

If the secrets test trips, run `bun scripts/fixtures/capture.ts resanitize <dir>` and re-check.

Up: [scripts](../README.md).
