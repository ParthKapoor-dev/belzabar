// What `ad test` / `ad run` really execute (B1, B14, B22): ranVersion, a published uuid whose
// draft has unpublished changes, callees whose draft does not run, async steps. Over the real
// draft/published V2 pair in fixtures/draft-published (4f6331f1… published, 4283bb05… its draft)
// and the real V1 body in fixtures/real-v1.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runCommand } from "@belzabar/core/testing";
import testCommand from "../../commands/test/index";
import runCommandModule from "../../commands/run/index";
import { calleeDrafts, ranVersionOf, runWarnings, testRouteInputWarnings, unpublishedDraftOf } from "../../lib/run-context";
import type { HydratedMethod } from "../../lib/types/common";
import { definitionRoute, fakeAdEnv } from "./helpers/fake-ad";

const FIX = join(import.meta.dir, "../fixtures");
const PUB = "4f6331f11208e5ccc8ddaaad20727664";
const DRAFT = "4283bb05ec15bdc2f723a7a75551ed08";
const ENV = "t-run-context";
const read = (p: string) => JSON.parse(readFileSync(join(FIX, p), "utf8"));
const pubV2 = () => read(`draft-published/${PUB}.published.v2.json`);
const draftV2 = () => read(`draft-published/${DRAFT}.draft.v2.json`);
/** The draft with a different time limit: different logic from the published copy (a description is not logic). */
const changedDraft = () => {
  const d = draftV2();
  d.metadata = { ...d.metadata, executionTimeLimit: { timeoutInSecond: 999 } };
  return d;
};
/** A draft with the published copy's logic. */
const syncedDraft = () => ({ ...pubV2(), uuid: DRAFT, metadata: { ...pubV2().metadata, state: "DRAFT", referenceId: PUB } });
const V2 = (u: string) => new RegExp(`/chain/v2/${u}`);

const ad = fakeAdEnv({ env: ENV });
afterEach(() => ad.restore());

function wire(draft: unknown, extra: Array<{ method?: string; url: string | RegExp; response: unknown }> = []) {
  ad.install([
    { method: "GET", url: `/rest/api/automation/chain/${PUB}`, response: read(`real-v1/${PUB}.v1.json`) },
    { method: "GET", url: V2(PUB), response: pubV2() },
    { method: "GET", url: V2(DRAFT), response: draft },
    definitionRoute(),
    { method: "POST", url: "/rest/api/automation/chain/test", response: { executionStatus: { failed: false }, services: [], outputs: [] } },
    { method: "POST", url: /\/chain\/execute\//, response: { ok: 1 } },
    ...extra,
  ]);
}

describe("ranVersionOf", () => {
  test("names the copy", () => {
    expect(ranVersionOf({ uuid: "u", state: "PUBLISHED", version: 5 } as HydratedMethod).label).toBe("PUBLISHED v5");
    expect(ranVersionOf({ uuid: "u", state: "DRAFT", version: 6 } as HydratedMethod).label).toBe("DRAFT v6");
  });
});

describe("unpublishedDraftOf", () => {
  test("a published uuid whose draft has different logic names the draft; in sync gives null", async () => {
    wire(changedDraft());
    const pub = { uuid: PUB, state: "PUBLISHED", version: 1, referenceId: DRAFT } as HydratedMethod;
    expect(await unpublishedDraftOf(pub)).toEqual({ publishedUuid: PUB, draftUuid: DRAFT, draftVersion: 11 });
    wire(syncedDraft());
    expect(await unpublishedDraftOf(pub)).toBeNull();
  });

  test("a draft, or an unreadable side, gives no warning", async () => {
    wire(changedDraft());
    expect(await unpublishedDraftOf({ uuid: DRAFT, state: "DRAFT", version: 11, referenceId: PUB } as HydratedMethod)).toBeNull();
    expect(await unpublishedDraftOf({ uuid: PUB, state: "PUBLISHED", version: 1, referenceId: "0".repeat(32) } as HydratedMethod)).toBeNull();
  });
});

describe("calleeDrafts", () => {
  const caller = {
    uuid: "c",
    state: "DRAFT",
    version: 2,
    parsedSteps: [
      { orderIndex: 3, kind: "EXISTING_SERVICE", serviceName: "Sandbox", methodName: "child.method" },
      { orderIndex: 5, kind: "EXISTING_SERVICE", serviceName: "Sandbox", methodName: "child.method" },
      { orderIndex: 6, kind: "EXISTING_SERVICE", serviceName: "Email", methodName: "send" },
      { orderIndex: 7, kind: "SPEL_ECHO", runAsync: true },
    ],
  } as unknown as HydratedMethod;
  const childInfo = { method: "GET", url: /automation-systems\/Sandbox\/automation-apis\/child\.method/, response: { serviceChainUID: PUB } };

  test("a callee whose draft differs from its published copy is named, with every step calling it", async () => {
    wire(changedDraft(), [childInfo]);
    const found = await calleeDrafts(caller);
    expect(found).toEqual([{ publishedUuid: PUB, draftUuid: DRAFT, draftVersion: 11, steps: [3, 5], category: "Sandbox", method: "child.method" }]);
    const lines = runWarnings(caller, null, found, { async: true });
    expect(lines[0]).toContain("Step 3, 5 calls Sandbox.child.method");
    expect(lines[0]).toContain("PUBLISHED copy");
    expect(lines[1]).toContain("Step 7 runs async");
    expect(runWarnings(caller, null, found)).toHaveLength(1); // ad run: no async line
  });

  test("an in-sync callee or a system service (no chain) gives nothing", async () => {
    wire(syncedDraft(), [childInfo]);
    expect(await calleeDrafts(caller)).toEqual([]);
  });
});

describe("testRouteInputWarnings (B2)", () => {
  const m = {
    inputs: [
      { code: "settings", type: "JSON" },
      { code: "label", type: "TEXT" },
      { code: "n", type: "INTEGER" },
    ],
  } as unknown as HydratedMethod;

  test("JSON text in a non-text input: the test route parses it", () => {
    const w = testRouteInputWarnings(m, [{ settings: '{"managingEntity":"ALL"}', label: '{"x":1}', n: 3 }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Input settings is JSON text");
    expect(w[0]).toContain("ad run");
  });

  test("an object value (any input): a Map on the test route", () => {
    const w = testRouteInputWarnings(m, [{ label: "x" }, { settings: { managingEntity: "ALL" } }, { label: ["a"] }]);
    expect(w).toEqual([expect.stringContaining("Input settings, label is an object")]);
    expect(w[0]).toContain("{a=1}");
  });

  test("plain values, and JSON text in a text input, warn nothing", () => {
    expect(testRouteInputWarnings(m, [{ settings: "plain", label: '{"x":1}', n: 3 }])).toEqual([]);
  });

  test("ad test warns (inline --inputs)", async () => {
    wire(syncedDraft());
    const r = await runCommand(testCommand, [PUB, "--inputs", '{"cityCode":{"a":1},"displayName":"D"}'], { env: ENV });
    expect(((r.envelope?.meta?.warnings as string[] | undefined) ?? []).join("\n")).toContain("Input cityCode is an object");
  });
});

describe("ad test / ad run", () => {
  test("ad test on a published uuid reports ranVersion and warns that its draft does not run (B1)", async () => {
    wire(changedDraft());
    const r = await runCommand(testCommand, [PUB, "--inputs", '{"cityCode":"C","displayName":"D"}'], { env: ENV });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).ranVersion).toEqual({ uuid: PUB, state: "PUBLISHED", version: 1, label: "PUBLISHED v1" });
    expect(((r.envelope?.meta?.warnings as string[] | undefined) ?? []).join("\n")).toContain(`not its draft ${DRAFT} (v11), which has unpublished changes`);
  });

  test("ad run on a published uuid reports ranVersion and the same warning (B1)", async () => {
    wire(changedDraft());
    const r = await runCommand(runCommandModule, [PUB, "{}"], { env: ENV });
    expect((r.envelope?.data as any).ranVersion.label).toBe("PUBLISHED v1");
    expect(((r.envelope?.meta?.warnings as string[] | undefined) ?? []).join("\n")).toContain("which has unpublished changes");
  });

  test("in sync: no warning", async () => {
    wire(syncedDraft());
    const r = await runCommand(testCommand, [PUB, "--inputs", '{"cityCode":"C","displayName":"D"}'], { env: ENV });
    expect(r.envelope?.meta?.warnings ?? []).toEqual([]);
  });
});
