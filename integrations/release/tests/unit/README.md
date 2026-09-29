# release/tests/unit

| File | Covers |
|---|---|
| `args.test.ts` | `matrix` / `freeze` argument parsing and ticket-ref spec checks |
| `spec-ledger.test.ts` | Spec validation before any request, env derivation from the project, `matrix` end to end over the real Teamwork capture, `freeze` without stage data, ledger safety (corrupt records, slug collisions, `--force`) |
| `matrix-collisions.test.ts` | Item selection per ticket kind, a ticket that fails to link, `classifyLeak` table, spine/stage from different projects |

AD tracing is answered with 503 in the collision tests, so every item is a trace-error row;
tests that need a Teamwork session seed it with `saveTeamworkSession`.
