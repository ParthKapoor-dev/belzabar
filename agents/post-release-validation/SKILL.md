---
name: post-release-validation
description: Validate an NSM release AFTER it has been deployed to production — confirm what actually landed on prod is correct and matches stage. Use whenever the user gives a set of PD published IDs (or AD methods) from a release and asks to verify/validate/check them on prod, says "post-release validation", "post-deploy check", "verify the release went out cleanly", "the release is on prod now — validate it", "check the translated phrases on prod", or shares release items with after-the-fact verification intent. This is the POST-deploy counterpart to the release-prep skill (which audits BEFORE the prod push) — trigger this one when the deploy has already happened. Strictly read-only: it never writes to prod. Pair with the belz-ai primer (always loaded) and optionally /nsm for LT-26x domain context.
---

# post-release-validation — verify an NSM release on production

After a release is pushed to prod, you need to confirm three things actually
hold for every Page Designer item in the release:

- **A — Collation.** Every direct child component of each release item is
  enumerated, so nothing in the dependency surface is missed.
- **B — Translation integrity.** Each item's (and child's) translation phrases
  are well-formed on prod — the kind of breakage that ships silently and only
  surfaces when a user switches language.
- **C — Prod ⇄ stage parity.** Each release item is structurally identical on
  prod and stage. A mismatch means the deploy didn't carry what stage had.

This skill is the post-deploy counterpart to **release-prep** (which audits a
release *before* the push). Use release-prep before; use this after.

## Read-only guarantee — non-negotiable

This skill **never writes to production or any environment.** It only ever runs
read commands: `belz pd show`, `belz pd translations`, `belz pd page-deps`,
`belz pd diff`, `belz pd find`. It must never run `belz pd save`, `publish`,
`lock`, or `history restore`. If a step seems to need a write, stop and ask the
user — do not improvise one.

---

## Stage 0 — Workspace

A release is platform-wide work, so the workspace is a first-class directory at
the **repo root** (not under `general/`), matching release-prep:

```
<release-name>-post-verify/        # e.g. may-19-release-post-verify
├── raw/             # belz --llm JSON dumps (show --components, translations, diff)
├── release-items.txt # Step B output — the standard team format
├── prod-stage-diff.txt # Step C output
└── TASK.md          # ad-hoc task log (belz-ai workflow)
```

If a directory by that name exists, suffix `-v2`, `-v3` — teams re-run validation.

Seed `TASK.md` with the supplied IDs, an `## Impact` section, and a `## Log`.
Update the Log as you complete each step.

The user supplies the **release items** — a set of PD published IDs (and
sometimes AD methods). Treat that list as the spine of the whole run.

---

## Step A — Collate direct child components

For each release item, enumerate its **direct child components** (symbols). You
need these because Step B must check translations for the whole dependency
surface, not just the top-level items.

Use the component tree, not the summary:

```bash
belz pd show <id> --components --env nsm-prod --llm \
  | jq -r '[.data.components.children[]?
            | recurse(.children[]?)
            | select(.isSymbol == true)
            | .name] | unique[]'
```

Why exactly this — three gotchas that have burned past runs:

- **Use `--components`, not the summary.** The summary's `directChildComponents`
  field is unreliable — it has included a literal `"div"` (an HTML layout
  element, not a component). Trust only the `--components` tree.
- **A node is a real child component iff `isSymbol == true`.** Plain elements
  (`div`, `span`, `a`, `exp-*`, `wis-redirect`) have `isSymbol == false`.
- **Skip the root node.** `.data.components` is the entity *itself*; for a
  component the root is often `isSymbol: true` and named `"div"`. The jq above
  starts at `.children[]`, so the root is never counted. Symbol nodes carry
  empty `children`, so every `isSymbol` node in the tree is a *direct* child.

Collect the union of all child component names across every release item.
Record per item: name, env, and its child list. Note which release items are
also children of each other.

---

## Step B — Translation validation

For every release item **and** every collated child component, validate its
translation phrases on prod with the new belz command:

```bash
belz pd translations <id-or-name> --env nsm-prod --llm
```

`belz pd translations` calls the page-dependencies API, resolves the entity's
draft + published ids itself, and returns a verdict in `data.check.verdict`:

- **PASS** — every `*__translated_phrases` key is a well-formed `page.<id>` /
  `symbol.<id>`, and the main entity's phrase keys embed its own draft id.
- **FAIL** — malformed keys, a missing/empty main array, or a draft-id
  mismatch. Surface `data.check.reason` and `data.check.badKeys` to the user.
- **N/A** — the entity has **no** `__translated_phrases` arrays at all. This is
  a style / font / image component with no translatable text. **N/A is
  expected, not a failure** — never report it as FAIL. (The old ad-hoc script
  wrongly conflated the two; the command now classifies it correctly.)

You no longer need to supply or hardcode the expected draft id — the command
resolves it. Use `--expect-draft <id>` only to override that resolution.

For the raw dependency graph (debugging a FAIL, or a one-off inspection), use
the unvalidated wrapper: `belz pd page-deps <id-or-name> --env nsm-prod --llm`.

### Emit `release-items.txt`

Write every entity the check ran on, in the team's standard format:

```
== release items ==
<name>, Pub Id: <pub>, Draft Id: <draft> - <status>
== child components ==
<name>, Pub Id: <pub>, Draft Id: <draft> - <status>  (child of <parent[, parent...]>)
```

`<status>` is `done` for PASS, `N/A - no translatable phrases (style/asset
component)` for N/A, or `FAIL - <reason>` for FAIL. Pull `pub`/`draft` from the
command's `data.entity`. If a release item was checked on a non-prod env
(env-local uuid — see below), append `  [NOT ON PROD - checked on <env>]`.

---

## Step C — Prod ⇄ stage structural diff

For each **release item** (not its children), diff prod against stage:

```bash
belz pd diff <id-or-name> --from nsm-prod --to nsm-stage --llm
```

Read `data.identical`. `true` → the item deployed cleanly. `false` → report the
structural delta from `data.diff` (variables / derived / http / nodes / styles)
— it means prod and stage disagree and the deploy needs a look.

`versionId` differs per environment (it's an env-local counter) — that is
expected; ignore it. Only the structural diff matters.

Write results to `prod-stage-diff.txt` with a one-line verdict per item and a
final `N/N identical` tally.

---

## Env-local UUID handling

The same PD page/component can carry a **different uuid in each environment**.
A uuid the user supplies may be the *stage* uuid, so it returns NOT_FOUND on
prod — this does **not** mean the item is undeployed.

When `belz pd translations` or `belz pd diff` fails to resolve an id on the
target env:

1. Resolve by name instead: `belz pd find "<name>" --env <targetEnv> --llm`,
   then `belz pd show <foundId> --env <targetEnv> --llm` for its env-local
   pub/draft ids.
2. Re-run the step against the env-correct id.
3. For `belz pd diff`, passing the **name** (not a uuid) is enough — diff
   resolves its input independently per environment, so it handles env-local
   uuids automatically.

Never flag an item as missing from prod on a bare NOT_FOUND — always try the
name resolution first.

---

## AD validation step — documented, not yet implemented

A release often also includes **AD methods**. The intended future step:

> For each AD method in the release, confirm the changes present on the STAGE
> environment for that method are also present on PROD — the AD analogue of
> Step C.

**Do not implement this yet.** When asked to build it, note that `belz` has no
`ad diff` command. The parity mechanism still needs to be chosen from what
exists: `belz ad show` (compare published bodies per env), `belz ad changelog`
/ `belz ad history` (compare change notes / versions), `belz ad trace`, or
`belz ad state`. Settle the definition of "in parity" with the user first —
latest-published-matches vs. all-stage-changes-present — then build it.

For now, if the user gives AD methods, tell them AD parity validation is a
planned step and is not automated yet.

---

## Final report

After all steps, give the user a written summary:

- **A** — N release items, M unique child components collated.
- **B** — translation verdict counts (PASS / N/A / FAIL); list every FAIL with
  its reason; confirm `release-items.txt` written.
- **C** — `N/N identical prod vs stage`; list any non-identical item with its
  delta.
- **Env-local uuids** — any item resolved by name and on which env.
- **Outstanding flags** — everything that needs a human's attention, or
  "No outstanding flags."

Keep the `TASK.md` Log current: one line per step completed.
