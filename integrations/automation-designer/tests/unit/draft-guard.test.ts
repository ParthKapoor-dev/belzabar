import { describe, expect, test } from "bun:test";
import { resolveDraftTarget, type ResolveDraftTargetDeps } from "../../lib/draft-guard";
import type { HydratedMethod, MethodState } from "../../lib/types/common";

function fakeMethod(overrides: Partial<HydratedMethod> & { uuid: string; state: MethodState }): HydratedMethod {
  return {
    sourceVersion: "v1",
    uuid: overrides.uuid,
    referenceId: overrides.referenceId ?? null,
    state: overrides.state,
    aliasName: "fake",
    version: 1,
    name: "fake.method",
    summary: "",
    category: null,
    inputs: [],
    variables: [],
    outputs: [],
    parsedSteps: [],
    assertions: [],
    securityFields: [],
    fetchedAt: 0,
    raw: {},
    parseWarnings: [],
    ...overrides,
  } as HydratedMethod;
}

function makeDeps(byUuid: Record<string, HydratedMethod>): ResolveDraftTargetDeps {
  return {
    async fetchMethod(uuid: string): Promise<HydratedMethod> {
      const m = byUuid[uuid];
      if (!m) throw new Error(`no mock for ${uuid}`);
      return m;
    },
  };
}

describe("resolveDraftTarget", () => {
  test("DRAFT with no referenceId — happy path", async () => {
    const draft = fakeMethod({ uuid: "draft-1", state: "DRAFT" });
    const deps = makeDeps({ "draft-1": draft });
    const result = await resolveDraftTarget("draft-1", "v1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.uuid).toBe("draft-1");
      expect(result.switchedFromPublished).toBe(false);
      expect(result.publishedUuid).toBeNull();
    }
  });

  test("DRAFT with linked published reference", async () => {
    const draft = fakeMethod({ uuid: "draft-1", state: "DRAFT", referenceId: "pub-1" });
    const deps = makeDeps({ "draft-1": draft });
    const result = await resolveDraftTarget("draft-1", "v1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publishedUuid).toBe("pub-1");
      expect(result.switchedFromPublished).toBe(false);
    }
  });

  test("PUBLISHED with linked draft — switches to the draft", async () => {
    const draft = fakeMethod({ uuid: "draft-2", state: "DRAFT", referenceId: "pub-2" });
    const published = fakeMethod({ uuid: "pub-2", state: "PUBLISHED", referenceId: "draft-2" });
    const deps = makeDeps({ "pub-2": published, "draft-2": draft });

    const result = await resolveDraftTarget("pub-2", "v1", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.uuid).toBe("draft-2");
      expect(result.publishedUuid).toBe("pub-2");
      expect(result.switchedFromPublished).toBe(true);
    }
  });

  test("PUBLISHED with no linked draft — fail PUBLISHED_NO_DRAFT", async () => {
    const published = fakeMethod({ uuid: "orphan-pub", state: "PUBLISHED", referenceId: null });
    const deps = makeDeps({ "orphan-pub": published });
    const result = await resolveDraftTarget("orphan-pub", "v1", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("PUBLISHED_NO_DRAFT");
      if (result.reason === "PUBLISHED_NO_DRAFT") {
        expect(result.publishedUuid).toBe("orphan-pub");
        expect(result.message).toContain("no linked draft");
      }
    }
  });

  test("PUBLISHED with referenceId that resolves to PUBLISHED — defensive failure", async () => {
    const p1 = fakeMethod({ uuid: "p1", state: "PUBLISHED", referenceId: "p2" });
    const p2 = fakeMethod({ uuid: "p2", state: "PUBLISHED", referenceId: "p1" });
    const deps = makeDeps({ p1, p2 });
    const result = await resolveDraftTarget("p1", "v1", deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "REFERENCE_NOT_DRAFT") {
      expect(result.resolvedState).toBe("PUBLISHED");
    }
  });

  test("whitespace-only referenceId is treated as null", async () => {
    const published = fakeMethod({ uuid: "pub", state: "PUBLISHED", referenceId: "   " });
    const deps = makeDeps({ pub: published });
    const result = await resolveDraftTarget("pub", "v1", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("PUBLISHED_NO_DRAFT");
    }
  });
});
