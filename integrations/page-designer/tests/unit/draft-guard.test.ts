// PD-1 / PD-7 regression: the draft/published sibling must be resolved via the
// row's referenceId, never by page name. Fixture mirrors sems-dev, which has
// two unrelated "Add Student" pairs.
import { describe, test, expect } from "bun:test";
import { resolveDraftTarget, resolveLinkedPair, describeDraftGuardFailure } from "../../lib/draft-guard";
import { entityIdsFromRaw } from "../../lib/page-dependencies";
import type { RawPageResponse } from "../../lib/types/wire";

const CONFIG = JSON.stringify({ layout: { unSelectable: true }, variables: [] });

function row(id: string, status: string | undefined, referenceId: string | null, name = "Add Student"): RawPageResponse {
  return { id, name, status: status as any, referenceId, configuration: CONFIG };
}

// Pair A (the one under test) and pair B (same name, listed first by the name search).
const PUB_A = "4bde22f76091a82364fda322eeeda597";
const DRAFT_A = "4440a1a4628001dfb1b79aaec9dd55fe";
const PUB_B = "48ac453ee33bbe32f0248075df59ec71";
const DRAFT_B = "45f7671e3c51c7247e12a640e3fb6d85";

function depsFor(rows: RawPageResponse[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const calls: string[] = [];
  return {
    calls,
    deps: {
      fetchPage: async (id: string) => {
        calls.push(id);
        return byId.get(id) ?? null;
      },
    },
  };
}

const SEMS = [
  row(DRAFT_B, "DRAFT", PUB_B),
  row(PUB_B, "PUBLISHED", DRAFT_B),
  row(DRAFT_A, "DRAFT", PUB_A),
  row(PUB_A, "PUBLISHED", DRAFT_A),
];

describe("resolveDraftTarget (referenceId link)", () => {
  test("duplicate names: PUBLISHED A switches to its own linked draft, not the other 'Add Student'", async () => {
    const { deps, calls } = depsFor(SEMS);
    const r = await resolveDraftTarget(PUB_A, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draftId).toBe(DRAFT_A);
    expect(r.draftId).not.toBe(DRAFT_B);
    expect(r.publishedId).toBe(PUB_A);
    expect(r.switchedFromPublished).toBe(true);
    expect(r.draft.id).toBe(DRAFT_A);
    expect(calls).toEqual([PUB_A, DRAFT_A]);
  });

  test("DRAFT input stays put and reports its linked published id", async () => {
    const { deps } = depsFor(SEMS);
    const r = await resolveDraftTarget(DRAFT_A, deps);
    expect(r.ok && r.draftId).toBe(DRAFT_A);
    expect(r.ok && r.publishedId).toBe(PUB_A);
    expect(r.ok && r.switchedFromPublished).toBe(false);
  });

  test("never-published DRAFT (no referenceId) is ok with publishedId null", async () => {
    const { deps } = depsFor([row(DRAFT_A, "DRAFT", null)]);
    const r = await resolveDraftTarget(DRAFT_A, deps);
    expect(r.ok && r.publishedId).toBeNull();
  });

  test("PUBLISHED with no referenceId → PUBLISHED_NO_DRAFT (force-overridable)", async () => {
    const { deps } = depsFor([row(PUB_A, "PUBLISHED", null)]);
    const r = await resolveDraftTarget(PUB_A, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("PUBLISHED_NO_DRAFT");
    expect(describeDraftGuardFailure(r).code).toBe("PD_PUBLISHED_NO_DRAFT");
  });

  test("link whose back-reference points elsewhere → refuse (LINK_MISMATCH)", async () => {
    const { deps } = depsFor([row(PUB_A, "PUBLISHED", DRAFT_A), row(DRAFT_A, "DRAFT", PUB_B)]);
    const r = await resolveDraftTarget(PUB_A, deps);
    expect(!r.ok && r.reason).toBe("LINK_MISMATCH");
    if (!r.ok) expect(describeDraftGuardFailure(r).code).toBe("PD_DRAFT_LINK_UNRESOLVED");
  });

  test("link resolving to a non-DRAFT → refuse (LINK_WRONG_STATUS)", async () => {
    const { deps } = depsFor([row(PUB_A, "PUBLISHED", PUB_B), row(PUB_B, "PUBLISHED", PUB_A)]);
    const r = await resolveDraftTarget(PUB_A, deps);
    expect(!r.ok && r.reason).toBe("LINK_WRONG_STATUS");
  });

  test("dangling link → refuse (LINK_NOT_FOUND)", async () => {
    const { deps } = depsFor([row(PUB_A, "PUBLISHED", DRAFT_A)]);
    const r = await resolveDraftTarget(PUB_A, deps);
    expect(!r.ok && r.reason).toBe("LINK_NOT_FOUND");
  });

  test("missing status fails closed (UNKNOWN_STATUS), never treated as DRAFT", async () => {
    const { deps } = depsFor([row(PUB_A, undefined, DRAFT_A)]);
    const r = await resolveDraftTarget(PUB_A, deps);
    expect(!r.ok && r.reason).toBe("UNKNOWN_STATUS");
  });

  test("input not found → NOT_FOUND", async () => {
    const { deps } = depsFor([]);
    const r = await resolveDraftTarget(PUB_A, deps);
    expect(!r.ok && r.reason).toBe("NOT_FOUND");
  });
});

describe("entityIdsFromRaw (pd translations / page-deps)", () => {
  test("duplicate names: draft input reports its own published sibling", async () => {
    const { deps } = depsFor(SEMS);
    const ids = await entityIdsFromRaw(row(DRAFT_A, "DRAFT", PUB_A), "PAGE", deps);
    expect(ids).toEqual({ name: "Add Student", entityType: "PAGE", draftId: DRAFT_A, publishedId: PUB_A });
  });

  test("published input reports its own linked draft", async () => {
    const { deps } = depsFor(SEMS);
    const ids = await entityIdsFromRaw(row(PUB_B, "PUBLISHED", DRAFT_B), "PAGE", deps);
    expect(ids.draftId).toBe(DRAFT_B);
    expect(ids.publishedId).toBe(PUB_B);
  });

  test("contradictory link throws PD_DRAFT_LINK_UNRESOLVED", async () => {
    const { deps } = depsFor([row(DRAFT_A, "DRAFT", PUB_B)]);
    await expect(entityIdsFromRaw(row(PUB_A, "PUBLISHED", DRAFT_A), "PAGE", deps)).rejects.toMatchObject({
      code: "PD_DRAFT_LINK_UNRESOLVED",
    });
  });

  test("resolveLinkedPair is name-agnostic (no name lookups at all)", async () => {
    const { deps, calls } = depsFor(SEMS);
    await resolveLinkedPair(row(PUB_A, "PUBLISHED", DRAFT_A), deps);
    expect(calls).toEqual([DRAFT_A]);
  });
});
