---
name: release-prep
description: Audit and assemble a production release for NSM (or any belz-managed project). Use whenever the user shares a set of "included" and/or "excluded" Teamwork ticket links and asks to (a) collate the AD/PD/DB items for a release, (b) verify everything is present on the stage env, (c) check for collisions against tickets that must NOT go to prod yet, or (d) determine whether excluded-ticket changes have already leaked onto stage. Triggers on "<month-day> release", "release prep / release audit / release readiness", "collate release items", "what's in this release", "stage verification before prod", "included vs excluded tickets", or any time 2+ Teamwork URLs are shared with explicit/implicit deploy intent — even if the user doesn't say "release-prep". Pair with the belz-ai primer (always loaded) and optionally /nsm for domain context on LT-26x forms.
---

# release-prep — NSM production-release audit

This skill captures the **exact procedure** used to assemble and validate a production push for NSM. Every release a previous session ran went wrong in at least one place when the procedure was abbreviated, so the stages below are ordered to catch each known failure mode (Round-1-vs-Round-2 dev notes, DELETED stage pages, draft↔published ID confusion). Don't reorder, don't skip — each stage exists because something burned us.

This skill is meant to be invoked at the start of a release window when the user gives you:
- a list of **included** Teamwork ticket URLs (must ship in this release), and
- a list of **excluded** Teamwork ticket URLs (must NOT ship — usually because they're still at UAT or were rejected late).

It produces:
- a per-release workspace dir with all raw fetched data + analysis,
- a `release-items.txt` in the team's standard format, and
- a written report covering: items found, stage verification, collisions, leak status, and recommended actions before the prod push.

Pair with **belz-ai** (CLI primer — always loaded) and optionally **/nsm** (domain context, opt-in).

---

## Stage 0 — Workspace setup

Pick a release name from the user's framing: usually `<month>-<day>-release` (e.g. `may-12-release`). If a directory by that name already exists in the repo root, suffix with `-v2`, `-v3`, etc. — the team often does several passes per release.

Create the workspace **at the repo root**, not under `general/`. A release touches the whole platform; it's first-class scratch work, not an ad-hoc question.

```
<release-name>/
├── raw/            # belz tw task + belz tw comments JSON dumps
├── analysis/       # extracted-ids.json, set-arithmetic txt files
├── stage-check/
│   ├── ad/         # belz ad show --env nsm-stage per AD id
│   └── pd/         # belz pd show --env nsm-stage per PD id
├── stage-vs-dev/   # full configs for colliding items, both envs
├── release-items.txt
└── TASK.md
```

Seed `TASK.md` with the included/excluded ticket lists, an `## Impact` section (`AD/PD/DB: TBD`), and a `## Log` section. Update Log and Impact as you make discoveries.

---

## Stage 1 — Fetch every ticket and its comments

For each included AND excluded ticket, fetch task metadata plus comments. Long-lived NSM tickets often have BE/FE/QA subtasks — check `data.task.subtasks[]` from the task response and fetch comments for those subtask IDs too, because the dev notes (with the actual AD/PD ID lists) sometimes live in the subtasks rather than the parent.

Always pass `--llm` so the output is parseable. Run in parallel:

```bash
for tid in <all-ticket-ids>; do
  belz tw task     $tid --llm > raw/tw-$tid.json &
  belz tw comments $tid --llm > raw/comments-$tid.json &
done
wait
# then fetch subtask comments for any subtask IDs surfaced by tw task
```

---

## Stage 2 — Extract AD / PD / DB items from comments

Items live in three patterns inside comments. Look for all three — different developers use different conventions:

**Pattern A — URLs:**
- AD: `https://<host>/automation-designer/<category>/<32-hex>`  → the hex is the AD chain UUID (same as the published ID).
- PD page (draft): `https://<host>/ui-designer/page/<32-hex>/compare?version=...` → the hex is the **draft** ID, not the deployable.
- PD symbol (by name): `https://<host>/ui-designer/symbol/<symbol-name>/compare?version=...` → no hex in the URL, you'll resolve the symbol name to its IDs in Stage 3.

**Pattern B — "PD Pages Published" / "PD (Published Id)" lists:**
```
PD Pages Published : <hex>,<hex>,<hex>,<hex>
```
These are the **published deployable** IDs. They are different IDs from the drafts in pattern A even when referring to the same logical page.

**Pattern C — "AD (Published Id)" / "AD: <csv>" / "Methods:" blocks:**
```
AD (Published Id): <hex>,<hex>,...
```
or
```
Methods:
https://<host>/automation-designer/...
https://<host>/automation-designer/...
```

### Critical lesson — prefer the LATEST dev-note block

Long tickets sometimes contain **two or more rounds of dev notes** because the approach was rewritten after VGD review or a late requirements change. Example we burned on: a ticket once proposed modifying six `LTxxx.update` methods, then after VGD pushback was rewritten to a regenerate-on-download flag (3 methods + 1 ALTER TABLE). **Only the final "Items to move" / "PD Pages Published" / "Methods:" block represents what's actually delivered.** Naively unioning every Method/AD ID across all comments will include obsoleted work that already went to prod in a prior release.

How to spot it:
- The ticket has 25+ comments.
- There are 2+ distinct "Methods:" or "Items to move" blocks separated by review comments.
- The status moved back to "On Hold" / "Support" between the two blocks.
- The final block is followed by "Migrated to QA → UAT → STAGE" sequence.

When in doubt, take the dev-note block immediately preceding the FINAL successful migration sequence. Ignore earlier method lists.

### DB vs Corrective fixes bucketing

Extract DB-change SQL from inline blocks in the comments. Split by SQL kind:
- **DB** = schema changes (`ALTER TABLE`, `CREATE TABLE`, `CREATE INDEX`, `DROP …`).
- **Corrective fixes** = data/config patches (`INSERT`, `UPDATE`, `DELETE`, `jsonb_set` patches on metadata tables).

This split matters because the team's prod-push process runs them at different stages (DDL first, data fixes after).

Save the per-ticket breakdown to `analysis/extracted-ids.json`.

---

## Stage 3 — Resolve PD drafts → published; verify EVERYTHING on stage

For every PD entity found (whether by draft hex, by published hex, or by symbol name), run:

```bash
belz pd show <id-or-name> --env nsm-stage --force --llm
```

and read `data.summary`. You're after:
- `name`, `entityType` (PAGE / COMPONENT)
- `draftId`, `publishedId` — the canonical IDs on this env
- `status` — **must be `PUBLISHED`** for the item to be live on stage
- `adMethodIds` — direct AD method calls from this page (used by Stage 5 collision check)
- `directChildComponents[].name` — direct child components (used by Stage 5)

For AD:

```bash
belz ad show <uuid> --env nsm-stage --force --llm
```

Pull `data.summary.{name, category, state, version}` and verify `state == PUBLISHED`.

Always pass `--force`. Stage state changes through migrations; a 5-minute-old cached response can be wrong about what's actually deployed.

Run all checks in parallel — there are typically 20-40 IDs to verify.

### Critical lesson — `ok=true` is not enough; check `status`

`belz pd show` can return `ok=true` for a page that's `DELETED` on stage. This happens when a page was re-imported with new UUIDs (apparently NSM's deploy pipeline doesn't preserve page UUIDs across envs the way AD chain UUIDs are preserved). The dev comments will reference the dev-side draft hex, which on stage either points to a DELETED record or doesn't exist at all. The real live page on stage has a different (draftId, publishedId) pair entirely.

**When you see `status == "DELETED"` or "not found"**:
1. Get the entity's NAME from the dev env: `belz pd show <dev-draft-id> --env nsm-dev --force --llm | jq '.data.summary.name'`
2. Look up the live ID on stage by name: `belz pd find "<name>" --env nsm-stage --llm` or `belz pd show "<name>" --env nsm-stage --force --llm`
3. Use the resolved publishedId in release-items.txt — not the dev-side ID.

For AD methods: UUIDs **are** stable across envs. An AD method missing on stage usually means the ticket wasn't actually migrated there yet. Flag it if the comments claim it was. New AD methods introduced by an excluded ticket should be expected to be missing on stage — that's a healthy "stage doesn't have the excluded work yet" signal.

---

## Stage 4 — Write `release-items.txt`

Final deliverable, in this exact format. Example:

```
AD:
<csv of unique AD UUIDs, lowercase, no spaces>

PD:
<csv of unique PD PUBLISHED deployable IDs, lowercase, no spaces>

DB:
<each schema-change statement on its own line, semicolon-terminated>

Corrective fixes:
<each data-fix statement on its own line, semicolon-terminated>
```

Rules:
1. **PD list contains published deployable IDs only**, not drafts. Migrations deploy the deployable; drafts are dev-only state.
2. **AD list contains chain UUIDs** as they appear in `automation-designer/<cat>/<uuid>` URLs.
3. **Dedupe everything.** Sort alphabetically for stability.
4. **DB vs Corrective fixes** is a SQL-kind split, not a per-ticket split.
5. **One contiguous comma-separated line per category** — don't break the CSV across lines or insert spaces.

Sanity-check the totals against the user's expectation. If a count is off, you've almost certainly hit one of:
- Unioned Round 1 + Round 2 of a rewritten dev note (Stage 2 issue) → trim to the latest block.
- Used a draft hex instead of the published deployable (Stage 3 issue) → re-resolve via `belz pd show`.
- Missed a `status == DELETED` page and shipped the wrong published ID (Stage 3 issue) → look up by name.

---

## Stage 5 — Collision check (included vs excluded)

The release scope is bigger than just the IDs listed in the included tickets. An included PD page also brings its **direct AD method calls** and **direct child components** along — anyone running QA against the included tickets is implicitly QA'ing those too. A collision happens when the transitive surface of the *included* set overlaps with the direct surface of the *excluded* set.

Compute these sets:
- `INCLUDED_AD_DIRECT` — AD UUIDs explicitly listed in included tickets.
- `INCLUDED_PD_AD` — `data.summary.adMethodIds` from every included PD page (union).
- `INCLUDED_PD_NAMES` — `data.summary.name` from every included PD page/symbol.
- `INCLUDED_PD_CHILDREN` — `data.summary.directChildComponents[].name` from every included PD page (union).
- `EXCLUDED_AD` — AD UUIDs listed in excluded tickets.
- `EXCLUDED_PD_NAMES` — names of every PD page/symbol listed in excluded tickets.

Intersect:

```
AD collisions  =  (INCLUDED_AD_DIRECT ∪ INCLUDED_PD_AD)         ∩  EXCLUDED_AD
PD collisions  =  (INCLUDED_PD_NAMES   ∪ INCLUDED_PD_CHILDREN)   ∩  EXCLUDED_PD_NAMES
```

Use **UUIDs for AD** (stable across envs); **NAMES for PD** (because IDs vary by env and between draft/published, but the entity name is the only stable cross-env identifier).

A `comm` or `grep -Fxf` over sorted text files is the cleanest way to compute these intersections; dump each set to a `.txt` under `analysis/` first.

Report each collision with full context: which included ticket pulls it in, which excluded ticket also touches it, and the human-readable name.

---

## Stage 6 — Has the collision LEAKED onto stage?

A collision is only a problem if the excluded ticket's changes have actually reached stage already. The check: compare the colliding item between `nsm-dev` and `nsm-stage`.

**For PD pages/components**, use `belz pd diff` — it resolves the item independently in each environment and reports a structural diff. Env-local fields (versionId, identity numbers) are ignored automatically, so there's no need to hash sections by hand:

```bash
for id in <colliding-pd-ids>; do
  belz pd diff $id --from nsm-dev --to nsm-stage --llm > stage-vs-dev/pd-$id-diff.json &
done
wait
```

Read `.data.identical` from each result: `true` → stage already matches dev for this item; `false` → inspect `.data.diff` (variables / derived / httpRequests / nodes / styles) for exactly which section diverges.

**For AD methods**, `pd diff` does not apply — pull both envs and hash the step tuples. Don't hash raw response bytes; env-local fields like `identity` always differ.

```bash
for id in <colliding-ad-ids>; do
  belz ad show $id --full --env nsm-stage --force --llm > stage-vs-dev/ad-$id-stage.json &
  belz ad show $id --full --env nsm-dev   --force --llm > stage-vs-dev/ad-$id-dev.json   &
done
wait
```

Hash the array of `(orderIndex, kind, description)` tuples — skip the `identity` field, which is env-local:

```bash
jq -r '.data.steps[] | "\(.orderIndex) \(.kind) \(.description // "—")"' ad-$id-stage.json | sha256sum
jq -r '.data.steps[] | "\(.orderIndex) \(.kind) \(.description // "—")"' ad-$id-dev.json   | sha256sum
```

### Interpretation

- **All sections identical between stage and dev** → stage already contains whatever dev has, including the excluded ticket's edits to this item. The excluded change has LEAKED in via the included-ticket migration. Flag this — it's the highest-severity finding.
- **Some sections differ** → stage is at an older version. Excluded changes have NOT reached stage for this item. Note which section differs (often a single var rename or one new HTTP call signals which specific NCNSS-372-style edit is on dev but not stage yet).

### Why the draft-version chain matters

For PD pages specifically, check the `compare?version=A-B` ranges in the diff URLs across both included and excluded tickets:

- Excluded ticket modifies page X: `compare?version=397233-402847` on dev.
- Included ticket later modifies the same page X: `compare?version=402847-406578` on dev.

The included ticket's *starting* version (402847) is exactly the excluded ticket's *ending* version. That means the included ticket's draft inherits everything the excluded ticket did. When the included ticket then migrates to stage, it carries the excluded ticket's edits along, even though the excluded ticket itself was never officially promoted.

Always look at the `from-to` version ranges across tickets that touch the same draft. They tell you the chronological order on dev and whether one ticket's work piggybacks another's.

### Substantive marker check

Beyond hashing, grep both stage and dev configs for excluded-ticket signature strings — variable names, table names, button text, anything the excluded ticket specifically introduced (e.g., a name like `setPlaceStoredForDWI` or `vehicleLocationConfig`). Presence-on-stage of a known excluded marker is definitive evidence of leakage.

---

## Final report

Write a concise report to TASK.md (and to the chat). Include:
1. **Per-ticket items found** — AD/PD/DB with human names, not just UUIDs.
2. **Stage verification** — every item confirmed `status == PUBLISHED` on stage (or flagged: missing/DELETED/wrong-version).
3. **Collisions** — AD and PD, with contributing included AND excluded tickets, and the entity name.
4. **Leak status per collision** — `LEAKED` (stage matches dev) / `CLEAN` (stage older) / `PARTIAL` (some sections match).
5. **Recommended actions before prod push** — e.g., "manual QA the LT-261 Details page on stage for orphan DWI elements", "confirm with reviewer that the inherited delta is acceptable", "revert symbol X from the migration list".

---

## Hard rules

1. **Always pass `--llm`** to every `belz` call you make. Human-mode tables are unparseable.
2. **Always pass `--force`** to stage queries. Stage state changes through migrations; cached responses can be 5+ minutes stale.
3. **Read every comment of every ticket.** Don't shortcut. The final "Items to move" / "PD Pages Published" / "Methods:" block — usually near the end, just before the migration sequence — is the actual release scope. Earlier blocks may have been superseded.
4. **Check `status == PUBLISHED`** on stage. `ok == true` is not enough. DELETED pages still return `ok=true`.
5. **PD draft ≠ PD published** — both are valid hex IDs. Only the published deployable goes in release-items.txt. The entity name is the stable cross-env identifier.
6. **AD UUIDs are stable across envs**; PD IDs are NOT. Resolve missing/DELETED PD lookups by name; AD lookups by UUID work fine.
7. **Compare PD collisions by NAME**, AD collisions by UUID. Same reason — IDs vary, names don't.
8. **Don't invent IDs.** Always verify via `belz`. If something feels off, run `belz pd find` or `belz ad find` and reconcile against what the comments claim.
9. **Don't dump ticket descriptions or full comments into TASK.md.** Fetch on demand. TASK.md holds derived facts only — IDs, names, collisions, leak status.

---

## Common gotchas seen in past releases

- A ticket lists "Methods: A,B,C,D,E,F" then later "Items to move: A only". Use the latter. The first five methods were Round 1 of a rewritten approach that already shipped to prod.
- A page diff URL gives you a draft ID; the deployable that migrates is a different ID. Always resolve via `belz pd show <draft-id>` and use `summary.publishedId`.
- A page on dev exists at one `(draft, published)` pair; on stage it exists under a DIFFERENT pair because it was re-imported. `belz pd show <dev-draft-id> --env nsm-stage` will return `status: DELETED`. Search by name on stage instead.
- A symbol is referenced in comments only by its name (e.g., `n_s_side-bar-nav-link`). `belz pd show <symbol-name>` resolves it to the current `publishedId` on the queried env.
- `DB` and `Corrective fixes` are different categories: DB = DDL, Corrective fixes = DML/seed/jsonb_set. The split matters because they often run at different stages of the prod push.
- "Migrated to STAGE" in a comment is a self-report and can be wrong. Stage verification (Stage 3) is the source of truth.
