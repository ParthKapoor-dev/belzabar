# Code Review Brief — PD Safe-Edit in belz-cli

**You are a code-review agent.** You have no prior context on this repository or the work that was
done. Read this file top-to-bottom, then execute the review. Everything you need to be productive
is in this single document.

---

## 0. Scope of your task

Review a substantial change to the Page Designer (PD) module of the **belz-cli** monorepo. The
author claims to have built a safer editing path, a version-history UX, a validator gate, and a
richer inspection command. Your job:

1. **Verify the claims.** Open the files, read them critically, run the test suite, execute the
   new commands against the live dev environment, and look for real problems.
2. **Flag real bugs** — correctness issues, security issues, broken error paths, missing gates,
   shape mismatches between the wire and in-memory types, things that look plausible in
   isolation but will fail in practice.
3. **Do not rewrite.** If you find a bug, describe it clearly (file, line, repro, fix suggestion)
   and move on. Do not open a sprawling refactor.

**Output format:** a single markdown report at the end with one section per issue. Include
`SEVERITY: blocker | major | minor | nit`, the file and line number, a clear repro, and what you
think the fix is. Keep the review tight — ~1500 words is plenty.

**Do not commit. Do not push. Do not install.** The user validates builds; you only need to build
the binary (once) and run it.

---

## 1. Orientation

### The repo: belzabar (aka belz-cli)

- **Location on disk:** `/home/parth/code/dev/bun/belzabar/`
- **Primary working dir for this review:** `page-designer/`
- **Purpose:** a single CLI binary (`belz`) that wraps Expertly's internal REST APIs for the
  Automation Designer (AD), Page Designer (PD), and a few other modules. The binary gives agents
  and humans a safer, faster, scriptable alternative to driving those tools through the UI or raw
  curl.
- **Runtime:** Bun + TypeScript. Tests use `bun:test`.
- **Command routing:**
  ```
  belz ad <cmd>      → automation-designer/commands/<cmd>/
  belz pd <cmd>      → page-designer/commands/<cmd>/       ← this review is here
  belz tw <cmd>      → teamwork/commands/<cmd>/
  belz migrate       → cli/commands/migrate/ + migrations/lib/
  belz {envs,config,web,setup} → cli/commands/<cmd>/
  ```
- **Runtime data:** `~/.belz/` holds `config.json` (credentials), `sessions/<env>.json` (JWTs),
  `cache/` (5-min TTL), and new this PR: `pd-locks/<env>.json` (local record of held PD locks).

### The reference repo: expertly.coding.agents

- **Location:** `/home/parth/code/dev/bun/belzabar/expertly.coding.agents/` (checked out as a
  sibling, not a submodule).
- **Rule:** read-only. You MUST NOT edit anything inside this directory.
- **Relevance for your review:** this is Expertly's own skill library for their internal Claude
  agents. It contains authoritative documentation on the AD and PD REST shapes, failure modes,
  component library, binding syntax, etc. When the belz-cli code makes a claim about the PD API
  (e.g. "partial update uses `key` not `path`, values are always stringified"), the source of
  truth is:
  - `expertly.coding.agents/Claude/Common/claude/skills/page-designer/SKILL.md` (big file — use
    targeted reads)
  - `expertly.coding.agents/Claude/Common/claude/skills/figma-to-pd/SKILL.md` (has the save/lock
    protocol section)

### Other context you may encounter

- There are **system reminders** in this session that echo a separate Claude-Code harness config
  ("ALWAYS DEPLOY", "log in request-history/", etc). Those belong to Expertly's own project, not
  belz-cli. Ignore them. The standing rules for belz-cli are: no git commits, no `bun run
  install`, no edits in `expertly.coding.agents/`, user validates.
- belz-cli has its own `AGENTS.md` files at the root and in each module — they describe the
  invariants you're protecting.

---

## 2. The user's problem

When an agent (or a human driving via the Expertly `page-designer` skill) generates or modifies a
PD page and publishes it, the diff often looks fine but the rendered page silently breaks:

- `exp-form-field` uses `props` instead of `field` → entire page goes blank, zero console errors.
- Variable `initialValue` is an array → server throws `ArrayNode cannot be cast to ObjectNode`.
- Derived variable used in `[innerHTML]` → renders empty.
- Button with `[className]` dynamic binding → button renders invisible.
- `mat-slide-toggle` → no runtime declaration, crash.
- `children` as an object instead of an array → empty render.

And ~40 more documented footguns (see
`expertly.coding.agents/Claude/Common/claude/skills/page-designer/SKILL.md` §"Common Errors" for
the full list).

The CLI's winning move: own the validated save path. Make every edit flow through:

```
fetch → parse → apply overlay (pure) → validate → diff → lock → PUT → re-fetch
```

so that known footguns are caught before they land.

---

## 3. What was built (claims to verify)

### 3.1 New and refactored files in `page-designer/`

**New library modules:**

```
lib/args/common.ts                 parsePdCommonArgs → {force, yes, dryRun, rest}
lib/types/common.ts                HydratedPage, ParsedNode union, Overlay, ValidationIssue
lib/types/wire.ts                  raw API shapes (RawPageResponse, RawHistoryEntry, etc.)
lib/types/legacy.ts                pre-rewrite types kept alive for analyze/reporter stack
lib/parser/index.ts                parsePage(raw) → HydratedPage façade
lib/parser/nodes.ts                discriminated ParsedNode walker
lib/parser/variables.ts            dual-format variable parser
lib/parser/http.ts                 HTTP request parser
lib/parser/refs.ts                 binding-ref extractors
lib/parser/legacy.ts               pre-rewrite extractors (still used by analyze/find-ad-methods)
lib/validator/index.ts             validateHydrated(page): ValidationIssue[]
lib/validator/rules/existing.ts    10 ported rules
lib/validator/rules/invariants.ts  8 new invariant rules
lib/serialize/apply.ts             pure (page, overlay) → HydratedPage
lib/serialize/full.ts              HydratedPage → stringified configuration
lib/serialize/operations.ts        overlay → pageElementOperations[]
lib/serialize/index.ts             strategy picker (partial vs full)
lib/api/client.ts                  raw HTTP wrappers (one per endpoint)
lib/api/index.ts                   pdApi façade
lib/draft-guard.ts                 resolveDraftTarget refuses PUBLISHED without --force
lib/lock.ts                        withLock(pageId, fn) — acquire / try / finally release
docs/api-notes.md                  belz-owned cheatsheet — read this FIRST during review
```

**New commands:**

```
commands/history/   list | show | diff | restore  (server-backed version history)
commands/preflight/ dry-run: parse + validate + optional overlay, no network write
commands/lock/      acquire | release | status    (manual lock control)
commands/save/      --overlay <file> | --config <file> — the safe-edit entry point
commands/publish/   POST /pages/{id}/publish wrapped in withLock
```

**Modified commands:**

- `commands/show/index.ts` — added `--tree` (kind-badge tree), `--node <id>` (single-node dump),
  `--var-graph` (variable write/read/derive/trigger map with dead-var detection). The existing
  `--vars/--http/--components/--full/--recursive/--raw` still work.
- `commands/validate/index.ts` — now delegates to `validateHydrated` (new validator) rather than
  the old string-based `validateConfig`.

**Deleted:**

- `lib/api.ts`, `lib/parser.ts`, `lib/types.ts` (replaced by `lib/api/`, `lib/parser/`,
  `lib/types/`).

**Unchanged but worth reading to understand the surrounding surface:**
`lib/{resolver,cache,page-finder,analyzer,reporter,comparator,url-parser}.ts`, plus
`commands/{find,find-ad-methods,analyze}/`.

**Root doc touched:** `page-designer/AGENTS.md` updated with new command table + directory map +
safe-edit invariants.

### 3.2 The overlay format (the primary edit surface)

```json
{
  "variables": {
    "add":    [{"name":"x","type":"String","initialValue":""}],
    "update": [{"name":"x","initialValue":"changed"}],
    "remove": ["dead"]
  },
  "derived": {
    "add":    [{"name":"d","from":["x"],"spec":"(function(p){return p.x})"}],
    "update": [{"name":"d","spec":"..."}],
    "remove": ["dead"]
  },
  "httpRequests": {
    "update": [{"callId":"sc-001","request":{"body":"{}"}}],
    "remove": ["sc-dead"]
  },
  "elements": {
    "operations": [
      {"key":"layout.children[0].props.innerHTML","value":"New",
       "operation":"UPDATE","dataType":"STRING"}
    ]
  },
  "styles": {"replace": ".latest-version .x { color: red }"}
}
```

The serializer picks `partial` vs `full` automatically:

- **partial** — overlay only has `variables.update`, `httpRequests.update`, `elements.operations`,
  `styles.replace`.
- **full** — overlay has `variables.add`/`remove`, any `derived.*`, or `httpRequests.add`/
  `remove`.

### 3.3 Invariants that must hold

1. **Every PUT goes through `withLock(pageId, fn)`.** Acquire → fn → release (in `finally`).
2. **Every write runs the validator on the POST-edit state.** Errors block unless `--force`.
3. **`resolveDraftTarget(pageId)` is the only path to a writable id.** PUBLISHED pages refuse
   unless `--force`.
4. **`raw` is preserved** on every ParsedNode, PageVariable, PageHttpRequest, and HydratedPage.
   Unknown shapes round-trip verbatim.
5. **Overlay is declarative.** The serializer is pure: `(HydratedPage, Overlay) → operations[] |
   fullConfigString`.
6. **Partial-update ops use `key` (NOT `path`) with stringified `value`s** per PD's contract.

### 3.4 Claims about the live API (verified during development, worth checking)

- `GET /rest/api/pagedesigner/pages/{id}` — page body; `configuration` is a stringified JSON.
- `PUT /rest/api/pagedesigner/pages/{id}` — body `{status, partialUpdate, configuration?,
  pageElementOperations?}`. `partialUpdate` is REQUIRED.
- `PUT /rest/api/pagedesigner/pages/lock/{id}?pageLockAction=ACQUIRED|RELEASED` — **both** verbs
  use query param. Body must not carry `pageLockAction`.
- `POST /rest/api/pagedesigner/pages/{id}/publish` — body `{landingPage, hostIds?}`.
- `GET /rest/api/pagedesigner/pages/history?pageId={id}` — array of `{id (=versionId), pageId,
  status, partialUpdate, updatedAt, updatedBy, userName}`. **Empirically**: entries only populate
  for pages that have been published at least once — pure DRAFT pages return `[]` even after
  saves bump `versionId`. (This is documented in `docs/api-notes.md` but worth sanity-checking
  yourself.)
- `GET /rest/api/pagedesigner/pages/version/{versionId}` — full page body at that version.
- `PUT /rest/api/pagedesigner/pages/revert/{versionId}` — restore.

---

## 4. How to review

### Reading order (recommended)

1. **`page-designer/docs/api-notes.md`** — the cheatsheet. The reviewer's ground truth for how
   the PD API actually behaves. Read every row; cross-check a few against the expertly skill.
2. **`page-designer/AGENTS.md`** — the module-level contract. Should match what's in the code.
3. **`page-designer/lib/types/common.ts`** — the unified shapes every command sees. If you find
   something misshapen here, everything downstream is suspect.
4. **`page-designer/lib/types/wire.ts`** — raw shapes. Sanity-check against a live response.
5. **`page-designer/lib/parser/{index,nodes,variables,http}.ts`** — the parser. Verify that every
   `ParsedNode` kind preserves `raw` and that the discriminator is exhaustive.
6. **`page-designer/lib/validator/rules/invariants.ts`** — the new rules. For each rule, assert
   (a) it fires on the bad shape and (b) it does NOT fire on a compatible good shape.
7. **`page-designer/lib/serialize/{apply,full,operations,index}.ts`** — the serializer. Focus on
   round-trip correctness and the partial-vs-full strategy decision.
8. **`page-designer/lib/draft-guard.ts`** and **`lib/lock.ts`** — the safety net. If these are
   wrong, the validator gate is a paper shield.
9. **`page-designer/lib/api/client.ts`** — the wire. Every verb has a one-liner; easy to audit.
10. **`page-designer/commands/save/index.ts`** — the flagship command. Walk the full flow.
11. **`page-designer/commands/{publish,history,preflight,lock,show,validate}/index.ts`** — the
    rest.
12. **`page-designer/tests/unit/*.test.ts`** — the tests. Check coverage gaps.

### What a real issue looks like

- Claim in docs doesn't match code.
- An assumption about a response shape that's actually different on the wire.
- `withLock` not wrapping a write path. `resolveDraftTarget` not called before a write.
- A validator rule that never fires, or fires on good shapes.
- Overlay operations that write to a key path that doesn't resolve.
- Round-trip loss: parse → serialize → parse changes observable shape.
- `raw` field clobbered or replaced with a shallow copy.
- Tests that assert something trivial (`expect(x).toBeTruthy()` on a hardcoded literal) rather
  than real behavior.
- Flags parsed without bounds checks (index-out-of-bounds on argv lookups, accepting `--version
  <next-flag>`, etc).
- Pre-existing strictness errors that tests hide.

### What is NOT an issue

- Strictness errors in the legacy `commands/{find,find-ad-methods,analyze}/` or
  `lib/page-finder.ts` that predate this change. You can see them with
  `cd cli && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep page-designer`. They were there
  before; the task was not to fix them.
- Empty-array history on a fresh draft page — that's the PD server's behavior, documented and
  tested.
- The `lib/cache.ts` alias `type PageConfigResponse = RawPageResponse;` — an intentional shim
  while the legacy analyzer stack survives alongside the new types.

---

## 5. Environment setup (one-time, ~90 seconds)

```bash
# 0. cd to the repo
cd /home/parth/code/dev/bun/belzabar

# 1. Confirm the test harness works
bun test page-designer/tests/unit/
bun test automation-designer/tests/unit/   # unrelated, but proves the harness

# 2. Build the binary (writes cli/belz — a standalone executable; does NOT install system-wide)
cd cli && bun run build && cd ..
BELZ=/home/parth/code/dev/bun/belzabar/cli/belz

# 3. Confirm auth works (will auto-refresh the JWT at ~/.belz/sessions/nsm-dev.json on 401)
"$BELZ" pd show 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --llm | head -c 300
```

**Test page** (user-owned, un-authed, dev-only, cleared for full CLI exercise):
- UUID: `4f126300499e4d83cd07a35b4d9af9e7`
- Name: `dummy-testing`
- URL: `https://nsm-dev.nc.verifi.dev/ui-designer/page/4f126300499e4d83cd07a35b4d9af9e7`
- env flag: `--env nsm-dev`

For a negative test you need a second page. Good candidates (published, long history — fine for
read-only exercise, DO NOT WRITE TO THEM):
- `47f5616c5e57e3e46924ae69b70f2d03` — "NCDMV NSM" — 500+ history entries
- `468c567f53992b08a635a2325cec0ef4` — "NCDOT-NSM-Signin"

---

## 6. Verification cases

Run each; each has an expected outcome. Flag any that diverge. `BELZ` is the built binary path.

### 6.1 Unit test baseline (expected: 64 pass, 0 fail)

```bash
bun test /home/parth/code/dev/bun/belzabar/page-designer/tests/unit/
```

### 6.2 Read-only on the test page

```bash
"$BELZ" pd show 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev                 # overview
"$BELZ" pd show 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --tree          # layout tree with [LAYOUT]/[FORM]/... badges
"$BELZ" pd show 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --var-graph     # expect: onInit + routeParams flagged DEAD
"$BELZ" pd show 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --node __node_id_2_798829_692985_168580  # LAYOUT_CONTAINER detail
"$BELZ" pd validate 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev             # expect: 0 errors, 2 UNUSED_VARIABLE warns
"$BELZ" pd preflight 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev            # expect: "Preflight clean"
"$BELZ" pd history list 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev         # expect: 0 entries (draft-only)
"$BELZ" pd history list 47f5616c5e57e3e46924ae69b70f2d03 --env nsm-dev --limit 5  # expect: table of 5 versions
```

### 6.3 Negative-path validator gate

```bash
mkdir -p /tmp/pd-review
cat > /tmp/pd-review/orphan.json <<'EOF'
{
  "elements": {
    "operations": [
      {"key":"layout.props.innerHTML","value":"{%nope%}",
       "operation":"UPDATE","dataType":"STRING"}
    ]
  }
}
EOF

# Should REFUSE with ORPHAN_BINDING error, non-zero exit, no network write
"$BELZ" pd save 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --overlay /tmp/pd-review/orphan.json --dry-run
echo "exit code: $?"
```

Construct 2–3 more negatives yourself — one for `ARRAY_INITIAL_VALUE` (variables.add with
`initialValue: []`), one for `INVALID_SLIDE_TOGGLE` (elements.operation inserting a
`mat-slide-toggle`). Verify each blocks.

### 6.4 Happy-path save (round-trip)

```bash
cat > /tmp/pd-review/update-onInit.json <<'EOF'
{ "variables": { "update": [{"name":"onInit", "initialValue": false}] } }
EOF

"$BELZ" pd save 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --overlay /tmp/pd-review/update-onInit.json --dry-run
# Expect: "Dry-run — no network write performed", strategy=partial, 1 operation
"$BELZ" pd save 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --overlay /tmp/pd-review/update-onInit.json --yes
# Expect: "Saved. versionId <old> → <new>" with different numbers
"$BELZ" pd show 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --force --llm | jq '.data.summary.versionId'
# Expect: the new versionId
```

### 6.5 Lock hygiene

```bash
"$BELZ" pd lock status --env nsm-dev
"$BELZ" pd lock acquire 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev
"$BELZ" pd lock status --env nsm-dev            # expect: one entry
"$BELZ" pd lock release 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev
"$BELZ" pd lock status --env nsm-dev            # expect: empty
# And check the on-disk record
cat ~/.belz/pd-locks/nsm-dev.json
```

Try to break it: open the page in the editor UI in another tab, then try `belz pd lock acquire`
— expect a 409 with a useful error message.

### 6.6 `--llm` envelope sanity

```bash
"$BELZ" pd show 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --var-graph --llm \
  | jq '.schema, .ok, (.data.varGraph | length), .data.varGraph[0].name'
"$BELZ" pd preflight 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --llm | jq '.data.validation'
"$BELZ" pd save 4f126300499e4d83cd07a35b4d9af9e7 --env nsm-dev --overlay /tmp/pd-review/orphan.json --dry-run --llm 2>&1 | tail -1 | jq '.error.code, .error.details.issues'
```

### 6.7 Draft-guard

Find a published id to target. Run:

```bash
# Should REFUSE without --force
"$BELZ" pd save 47f5616c5e57e3e46924ae69b70f2d03 --env nsm-dev --overlay /tmp/pd-review/update-onInit.json --yes
# expect: CliError "Page ... is PUBLISHED with no matching DRAFT"
```

DO NOT then pass `--force`. We do not want to write to a real published page during review.

### 6.8 Unsettling shape tests (pick 2–3 at random)

Pull a live page body once and assert the parser round-trips it without loss:

```bash
"$BELZ" pd show 47f5616c5e57e3e46924ae69b70f2d03 --env nsm-dev --force --llm \
  | jq -r '.data.summary.resolvedId'
# Use that id and read a real response via curl or via the binary's --raw
```

Then: does `parsePage(raw)` → `serializeFull(page)` → `parsePage(again)` produce the same
variables / derived / inputs / events / httpRequests? You can test this in a quick
`bun repl` session without touching the repo:

```bash
bun repl
> const raw = JSON.parse(await Bun.file("/tmp/real-page.json").text());
> const { parsePage } = await import("/home/parth/code/dev/bun/belzabar/page-designer/lib/parser/index");
> const { serializeFull } = await import("/home/parth/code/dev/bun/belzabar/page-designer/lib/serialize/full");
> const a = parsePage(raw);
> const b = parsePage({ ...raw, configuration: serializeFull(a) });
> a.variables.map(v => v.name).join(",") === b.variables.map(v => v.name).join(",")
```

---

## 7. Known quirks and deliberate design decisions

These may look odd but are intentional — don't flag as bugs.

- **`lib/types/legacy.ts`** exists alongside `common.ts`. The legacy analyze/reporter stack still
  consumes those types while the new commands use `common.ts`. Both can coexist; the legacy types
  will go away when analyze is rewritten (out of scope for this change).
- **`lib/parser/legacy.ts`** — the string-based extractors (`extractReferences`,
  `extractHttpSummary`, `validateConfig`, etc.) live here and are re-exported from
  `lib/parser/index.ts`. `show`, `find-ad-methods`, `analyze` still call these. Not dead code —
  they're the pre-rewrite surface.
- **`PageConfigResponse` in `lib/cache.ts`** is aliased to `RawPageResponse`. Keeps the analyze
  stack compiling without a second type surface.
- **Both acquire and release lock use query params** (same shape). Early version of `api-notes.md`
  described them asymmetrically; that was wrong and has been corrected. The server rejects
  body-as-JSON with a 400.
- **History returns `[]` for pure DRAFT pages.** The `history list` command handles this
  gracefully and documents it in `help.txt`. It's a PD server behavior, not a belz bug.
- **Bun imports use explicit `/index` on new packages** (e.g. `from "./api/index"`) because of a
  stale-dir-vs-file resolution issue during the phased cutover. If you find an import that
  fails, the fix is to add `/index` explicitly, not to add a re-export anywhere.
- **TypeScript strictness errors** already present in `commands/{show,analyze,find-ad-methods}/`
  and `lib/page-finder.ts` are pre-existing, not introduced by this change. Confirm by running
  `git log --oneline -- page-designer/commands/show/index.ts` to see they predate the diff.

---

## 8. Deliverable

At the end of your review, produce a markdown report with:

1. **Summary verdict** — is this safe to merge? Pick one: `ship / ship-with-minors /
   needs-changes / blocked`.
2. **Issues** — one section per finding, in severity order:
   - `SEVERITY: blocker|major|minor|nit`
   - `FILE: path/to/file.ts:<line>`
   - `REPRO:` the exact command or snippet that shows the issue
   - `CLAIM:` what the code (or doc) claims
   - `REALITY:` what you actually see
   - `SUGGESTED FIX:` one- or two-sentence direction
3. **Confidence notes** — things you could not fully verify (live-state dependent, flaky network,
   hard to reach without destructive operations), so the author knows where your review has gaps.

Keep it concise. The author reads these end-to-end.

Do not commit. Do not push. Do not install. Do not modify files outside
`/tmp/pd-review/` (which you own for scratch). You may build the binary once (`cd cli && bun run
build`).
