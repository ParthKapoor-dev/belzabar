# AGENTS.md — Page Designer (`@belzabar/pd`)

Working rules for agents changing `integrations/page-designer/`. What the package does and how
it works is in the READMEs; read the one for the directory you are touching:

- [`README.md`](./README.md): commands, contracts (envelope, error codes, writes, cache), known gaps
- [`commands/README.md`](./commands/README.md): command conventions, adding a command
- [`lib/README.md`](./lib/README.md): module map, write pipeline, snapshot and diff engine
- [`lib/api/README.md`](./lib/api/README.md): the verified wire contract (read before touching `lib/api/` or `lib/serialize/`)
- [`lib/serialize/README.md`](./lib/serialize/README.md), [`lib/validator/README.md`](./lib/validator/README.md), [`tests/README.md`](./tests/README.md)

## Contracts you must not break

- Commands reach the server only through `pdApi` and import types from `lib/types/common.ts`.
- Every write goes `resolveWriteTarget` → `withLock` → fresh fetch → plan → `validateEdit` →
  PUT → read-back verify. Never write a PUBLISHED row, never pair drafts by name (only
  `referenceId`), never send `/pages/revert/<publishedId>`, never release a lock belz did not
  take.
- A partial save must provably reproduce the planned config (`planSave` replay check) and use
  only verified key shapes; anything else is a full save. Do not widen `isVerifiedKeyShape`
  without new live evidence in `tests/fixtures/wire/`.
- Validator severities live only in `lib/validator/catalogue.ts`; real pages must stay at 0
  errors (`validator-real.test.ts`); issue messages must not embed shifting positions.
- Commands do not set `schema`: the runner names it `pd.<cmd>`. Write commands set `writes`.
- Keep the package project-agnostic: no client names, hosts or env URLs in code, docs or
  fixtures (fixtures come only through the sanitizing `scripts/fixtures/capture.ts`).

## Changing code safely

- Run `bun run check` from the repo root before every commit.
- A bug fix gets a regression test, command-level over `tests/unit/helpers/fake-pd.ts` where
  it touches a command. Wire behaviour changes go into the fake and the wire evidence together.
- Live writes: only on a dedicated scratch page, through the opt-in live suite
  (see [`tests/README.md`](./tests/README.md#live-write-suite-opt-in)).

## Maintainer rule

Any meaningful change here (commands, flags, output, lib files, pipeline behaviour) updates, in
the same commit: `registry.ts`, the command's `help.txt` / `desc.txt`, and the README of every
directory whose contents or contracts changed. Keep this file to agent rules and links; put
documentation in the READMEs.
