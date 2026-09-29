// Pins belz's PD write contract to live wire evidence (captured 2026-09-29 on a
// scratch page, sanitized, in tests/fixtures/wire/): the partial-op key shapes
// the server accepts (OTH-R1), the lock answers (NEW-5), and the revert form
// (OTH-R2). If the server changes, re-capture and these fail loudly.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { CliError } from "@belzabar/core";
import { fakeFetch, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { acquireLock, historyRestore, releaseLock } from "../../lib/api/client";
import { replayOperations } from "../../lib/serialize/index";
import { isVerifiedKeyShape } from "../../lib/serialize/paths";
import type { RawConfiguration, RawPartialUpdateOperation } from "../../lib/types/wire";
import { applyWireOps } from "./helpers/fake-pd";

const WIRE = join(import.meta.dir, "../fixtures/wire");
const load = <T>(f: string): T => JSON.parse(readFileSync(join(WIRE, f), "utf8")) as T;

interface KeyCase {
  what: string;
  op: RawPartialUpdateOperation;
  status: number;
  readBackEqualsPutAnswer: boolean | null;
  storedUnder: { map: string; prop: string | null; container: unknown };
}
const keys = load<{ cases: KeyCase[]; atomicBatch: { ops: RawPartialUpdateOperation[]; status: number } }>("partial-keys.json");

/** A 3-node page whose node `i` has an empty `map` (so the op's parent exists), or none for the missing-parent case. */
function scaffold(c: KeyCase): RawConfiguration {
  const children: Array<Record<string, unknown>> = [{}, {}, {}];
  const i = Number(/children\[(\d+)\]/.exec(c.op.key)![1]);
  const map = c.storedUnder.map.replace(/\[\d+\]$/, "");
  if (c.storedUnder.container !== null) children[i]![map] = c.storedUnder.prop === null ? [] : {};
  return { layout: { children } } as unknown as RawConfiguration;
}

describe("partial-op key shapes (OTH-R1, live evidence)", () => {
  test("the evidence covers accepted, rejected and silently-dropped shapes", () => {
    expect(keys.cases.filter((c) => c.status === 200).length).toBeGreaterThanOrEqual(15);
    expect(keys.cases.filter((c) => c.status === 500).map((c) => c.op.key)).toEqual(["layout.children[0].props.[attr.title]"]);
    // the PUT answers with the stored page: identical to the next GET
    for (const c of keys.cases.filter((x) => x.status === 200)) expect(c.readBackEqualsPutAnswer).toBe(true);
  });

  for (const c of keys.cases) {
    test(`${c.what}: ${c.op.key} → HTTP ${c.status}`, () => {
      if (c.status === 500) {
        // A dotted prop name: the server splits it and fails; belz must never send it.
        expect(isVerifiedKeyShape(c.op.key)).toBe(false);
        expect(applyWireOps({ layout: { children: [{ props: {} }] } }, [c.op as never])).toBeNull();
        return;
      }
      expect(isVerifiedKeyShape(c.op.key)).toBe(true);
      const replayed = replayOperations(scaffold(c), [c.op]);
      const fake = applyWireOps(scaffold(c), [c.op as never]) as { layout: { children: Array<Record<string, unknown>> } };
      if (c.storedUnder.container === null) {
        // Missing parent: the server answers 200 and stores nothing; belz's replay
        // refuses (null), so planSave never sends such an op as a partial save.
        expect(replayed).toBeNull();
        expect(fake).toEqual(scaffold(c) as never);
        return;
      }
      const i = Number(/children\[(\d+)\]/.exec(c.op.key)![1]);
      const map = c.storedUnder.map.replace(/\[\d+\]$/, "");
      const serverValue =
        c.storedUnder.prop === null ? c.storedUnder.container : (c.storedUnder.container as Record<string, unknown>)[c.storedUnder.prop];
      const pick = (cfg: unknown) => {
        const node = (cfg as { layout: { children: Array<Record<string, unknown>> } }).layout.children[i]!;
        return c.storedUnder.prop === null ? node[map] : (node[map] as Record<string, unknown>)[c.storedUnder.prop];
      };
      // belz's in-memory reading of the key == what the server stored == the fake server.
      expect(pick(replayed)).toEqual(serverValue);
      expect(pick(fake)).toEqual(serverValue);
    });
  }

  test("a batch with one bad key is atomic on the wire (500, nothing stored) and in the fake", () => {
    expect(keys.atomicBatch.status).toBe(500);
    expect(applyWireOps({ layout: { children: [{ props: { className: "x" } }] } }, keys.atomicBatch.ops as never)).toBeNull();
  });
});

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = cfg = null;
});

interface LockStep { step: string; status: number; body: unknown }
const lock = load<{ steps: LockStep[]; getWhileLocked: Record<string, unknown>; getAfterRelease: Record<string, unknown> }>("lock.json");
const step = (name: string) => lock.steps.find((s) => s.step === name)!;
const answer = (s: LockStep) => respond({ status: s.status, json: s.body });

describe("lock answers (NEW-5, live evidence)", () => {
  test("re-acquiring my own lock is a 400 (not 409); pageLockDetails says it is mine → heldByMe", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch([
      { method: "PUT", url: /pageLockAction=ACQUIRED/, response: answer(step("lock-acq2-reentrant")) },
      { method: "GET", url: /\/pages\/\w+$/, response: respond({ status: 200, json: lock.getWhileLocked }) },
    ]).install();
    const out = await acquireLock("0000000000000000000000000000d001");
    expect(out).toMatchObject({ acquired: false, heldByMe: true, lock: { lockedByCurrentUser: true, status: "ACQUIRED" } });
  });

  test("a free page acquires with 200 true", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch([{ method: "PUT", url: /pageLockAction=ACQUIRED/, response: answer(step("lock-acq1")) }]).install();
    expect(await acquireLock("x")).toEqual({ acquired: true });
  });

  test("the same 400 on a page locked by SOMEONE ELSE is PD_LOCKED naming the holder from pageLockDetails", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
    const theirs = { ...lock.getWhileLocked, pageLockDetails: { ...(lock.getWhileLocked.pageLockDetails as object), lockedByCurrentUser: false, userName: "user-0002", createdBy: 9 } };
    ff = fakeFetch([
      { method: "PUT", url: /pageLockAction=ACQUIRED/, response: answer(step("lock-acq2-reentrant")) },
      { method: "GET", url: /\/pages\/\w+$/, response: respond({ status: 200, json: theirs }) },
    ]).install();
    const err = await acquireLock("x").then(() => null, (e: CliError) => e);
    expect(err?.code).toBe("PD_LOCKED");
    expect(err?.details).toMatchObject({ status: 400, holder: { userName: "user-0002", userId: 9 } });
    expect(err?.message).toContain("user-0002");
  });

  test("a 400 with no lock on the page is a plain PD_API_ERROR (not a lock conflict)", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch([
      { method: "PUT", url: /pageLockAction=ACQUIRED/, response: answer(step("lock-acq2-reentrant")) },
      { method: "GET", url: /\/pages\/\w+$/, response: respond({ status: 200, json: lock.getAfterRelease }) },
    ]).install();
    expect((await acquireLock("x").then(() => null, (e: CliError) => e))?.code).toBe("PD_API_ERROR");
  });

  test("release answers 200 true (released) / 200 false (nothing of mine held); 5xx is unknown", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch([
      { method: "PUT", url: /lock\/held\?pageLockAction=RELEASED/, response: answer(step("lock-rel1")) },
      { method: "PUT", url: /lock\/free\?pageLockAction=RELEASED/, response: answer(step("lock-rel2-notheld")) },
      { method: "PUT", url: /lock\/down\?pageLockAction=RELEASED/, response: respond({ status: 503, text: "down" }) },
    ]).install();
    expect(await releaseLock("held")).toEqual({ status: 200, released: true });
    expect(await releaseLock("free")).toEqual({ status: 200, released: false });
    expect(await releaseLock("down")).toEqual({ status: 503, released: null });
  });
});

describe("revert form (OTH-R2, live evidence)", () => {
  const rv = load<{
    legacyVersionPath: { status: number; body: { errorMessage: string } };
    draftForm: { path: string; status: number; answer: Record<string, unknown>; answerConfig: unknown; historyAfter: unknown[] };
    publishedForm: { status: number; answer: { id: string; status: string; referenceId: string }; historyAfter: unknown[] };
  }>("revert.json");

  test("the evidence: /revert/<vid> is a 400; /revert/<draftId>?versionId= rewrites the draft; the published form rewrites the live row with no history", () => {
    expect(rv.legacyVersionPath.status).toBe(400);
    expect(rv.legacyVersionPath.body.errorMessage).toContain("'versionId'");
    expect(rv.draftForm).toMatchObject({ status: 200, answer: { status: "DRAFT", referenceId: "0000000000000000000000000000b001" } });
    // Reverting the PUBLISHED id corrupts the pair: that row becomes a DRAFT that references itself.
    expect(rv.publishedForm).toMatchObject({ status: 200, answer: { id: "0000000000000000000000000000b001", status: "DRAFT", referenceId: "0000000000000000000000000000b001" } });
    expect(rv.publishedForm.historyAfter).toEqual(rv.draftForm.historyAfter); // no history entry either way
  });

  test("historyRestore sends the draft form and returns the rewritten draft row", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
    const body = { ...rv.draftForm.answer, configuration: JSON.stringify(rv.draftForm.answerConfig) };
    ff = fakeFetch([{ method: "PUT", url: /\/pages\/revert\//, response: respond({ status: 200, json: body }) }]).install();
    const out = await historyRestore("0000000000000000000000000000d001", 100017);
    expect(new URL(ff.requests[0]!.url).pathname + new URL(ff.requests[0]!.url).search).toBe(
      "/rest/api/pagedesigner/pages/revert/0000000000000000000000000000d001?versionId=100017",
    );
    expect(out).toMatchObject({ id: "0000000000000000000000000000d001", status: "DRAFT", versionId: rv.draftForm.answer.versionId });
  });
});
