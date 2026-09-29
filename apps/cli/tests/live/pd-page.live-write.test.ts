// Opt-in live WRITE suite for Page Designer, on ONE scratch page you own.
//
//   BELZ_LIVE=<env> BELZ_LIVE_WRITE=1 BELZ_LIVE_PD_PAGE=<draftId> bun test apps/cli/tests/live/pd-page.live-write.test.ts
//   (plus whatever describeLiveWrite requires, e.g. the live category env vars)
//
// The page id is never hard-coded: without BELZ_LIVE_PD_PAGE the suite is
// skipped. Use a dedicated scratch page: the suite saves its draft, takes and
// releases its lock, publishes it WITHOUT a host (the deployed app is not
// redeployed) and restores a history version into the draft. afterAll puts the
// original draft config back (full save of the raw config read first), publishes
// it again when the suite published, releases any lock it left, and checks
// `pd snapshot --compare` against the first snapshot.
//
// Covers: lock acquire / re-acquire (400 → alreadyHeld) / status / save inside
// a manual lock / release / release-nothing; partial saves on binding-prop keys
// (verified shapes) and the full-save fallback for a dotted prop name; save
// read-back; snapshot --compare; publish validation gating + published history;
// history restore into the draft.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { EnvelopeSchema, LIVE_ENV, describeLiveWrite, registerLiveResource, markLiveResourceCleaned, scratchDir, spawnLive, type SpawnResult } from "@belzabar/core/testing";

const PAGE = process.env.BELZ_LIVE_PD_PAGE ?? "";
const T = 180_000;
const VAR = "belz_tst_pd_live_var";
const NODE = "belz_tst_pd_live_node";

async function belz(argv: string[]): Promise<SpawnResult> {
  return spawnLive([...argv, "--llm"], { timeoutMs: T - 10_000 });
}

function okData<D = Record<string, any>>(r: SpawnResult): D {
  expect(EnvelopeSchema.safeParse(r.envelope).success).toBe(true);
  expect({ ok: r.envelope?.ok, error: r.envelope?.error ?? null, exit: r.exitCode }).toEqual({ ok: true, error: null, exit: 0 });
  return r.envelope!.data as D;
}

const errCode = (r: SpawnResult) => (r.envelope?.error as { code?: string } | null)?.code;

const suite = PAGE ? describeLiveWrite : (name: string, fn: () => void) => describe.skip(`${name} (BELZ_LIVE_PD_PAGE unset)`, fn);

suite(
  "pd page lifecycle",
  () => {
    const dir = scratchDir("live-pd-");
    const file = (name: string, body: unknown) => {
      const f = join(dir, name);
      writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
      return f;
    };
    let originalRaw = "";
    let rootId = "";
    let published = false;
    let publishedId: string | null = null;
    let probeVersion = 0;

    beforeAll(async () => {
      okData(await belz(["pd", "snapshot", PAGE, "--out", join(dir, "original.snapshot.json")]));
      const show = okData<{ raw: { configurationRaw: string }; summary: { status: string } }>(await belz(["pd", "show", PAGE, "--raw", "--force"]));
      expect(show.summary.status).toBe("DRAFT");
      originalRaw = show.raw.configurationRaw;
      rootId = (JSON.parse(originalRaw) as { layout: { id: string } }).layout.id;
      writeFileSync(join(dir, "original.config.json"), originalRaw);
      registerLiveResource({
        agent: "pd-live-suite",
        kind: `PD page (existing scratch page, ${LIVE_ENV})`,
        identifier: PAGE,
        purpose: "pd live write suite: edits, lock, publish (no host), history restore; restored in afterAll",
        cleaned: "no — pending afterAll restore",
      });
    }, T);

    afterAll(async () => {
      if (!originalRaw) return;
      await belz(["pd", "lock", "release", PAGE]); // best effort: never leave the lock held
      const restore = await belz(["pd", "save", PAGE, "--config", join(dir, "original.config.json"), "--force-validation", "--yes"]);
      const restored = restore.envelope?.ok === true;
      if (restored && published) await belz(["pd", "publish", PAGE, "--force-validation", "--yes"]);
      const cmp = await belz(["pd", "snapshot", PAGE, "--compare", join(dir, "original.snapshot.json")]);
      const identical = cmp.envelope?.ok === true;
      markLiveResourceCleaned(PAGE, identical ? "yes — draft restored (snapshot --compare identical)" + (published ? ", original re-published (no host)" : "") : "NO — restore by hand from the suite's scratch dir");
      expect(identical).toBe(true);
    }, T * 2);

    test("lock: acquire, re-acquire is ok (alreadyHeld), status names me, save inside it keeps it, release, release-nothing", async () => {
      expect(okData(await belz(["pd", "lock", "acquire", PAGE]))).toMatchObject({ alreadyHeld: false });
      expect(okData(await belz(["pd", "lock", "acquire", PAGE]))).toMatchObject({ alreadyHeld: true });
      expect(okData(await belz(["pd", "lock", "status", PAGE]))).toMatchObject({ server: { locked: true, byMe: true } });
      const add = file("add.json", {
        variables: { add: [{ name: VAR, type: "String", initialValue: "one" }] },
        nodes: { insert: [{ parentId: rootId, node: { id: NODE, name: "div", props: { "[innerHTML]": `{%${VAR}%}` }, children: [] } }] },
      });
      const saved = okData(await belz(["pd", "save", PAGE, "--overlay", add, "--yes"]));
      expect(saved).toMatchObject({ strategy: "full", verify: { status: "match", source: "get" } });
      expect(okData(await belz(["pd", "lock", "status", PAGE]))).toMatchObject({ server: { locked: true, byMe: true } });
      expect(okData(await belz(["pd", "lock", "release", PAGE]))).toMatchObject({ released: true });
      const again = await belz(["pd", "lock", "release", PAGE]);
      expect(errCode(again)).toBe("PD_LOCK_RELEASE_FAILED");
      expect(again.envelope?.data).toMatchObject({ released: false, httpStatus: 200 });
      expect(okData(await belz(["pd", "lock", "status", PAGE]))).toMatchObject({ server: { locked: false } });
    }, T);

    test("binding-prop keys are partial saves, stored as sent; a dotted prop name falls back to a full save", async () => {
      const upd = file("upd.json", {
        nodes: { update: [{ id: NODE, props: { "[innerHTML]": `{%${VAR}%} `, "(click)": "noop", "data-x": "1", className: "c" } }] },
      });
      const d = okData<{ strategy: string; operationsPreview: Array<{ key: string }>; verify: { status: string } }>(
        await belz(["pd", "save", PAGE, "--overlay", upd, "--yes"]),
      );
      expect(d.strategy).toBe("partial");
      expect(d.operationsPreview.map((o) => o.key.split(".").pop())).toEqual(expect.arrayContaining(["[innerHTML]", "(click)", "data-x", "className"]));
      expect(d.verify.status).toBe("match");
      const dotted = file("dotted.json", { nodes: { update: [{ id: NODE, props: { "[attr.title]": "t" } }] } });
      const f = okData(await belz(["pd", "save", PAGE, "--overlay", dotted, "--yes"]));
      expect(f).toMatchObject({ strategy: "full", verify: { status: "match" } });
      expect(String((f as { fullSaveReason: string }).fullSaveReason)).toContain("[attr.title]");
    }, T);

    test("snapshot --compare reports the edit", async () => {
      const r = await belz(["pd", "snapshot", PAGE, "--compare", join(dir, "original.snapshot.json")]);
      expect(errCode(r)).toBe("PD_SNAPSHOT_DIFFERS");
      expect(JSON.stringify(r.envelope?.data)).toContain(NODE);
    }, T);

    test("publish is gated on an introduced error, then publishes (no host) and lands in the published history", async () => {
      const orphan = file("orphan.json", { nodes: { update: [{ id: NODE, props: { "[innerHTML]": "{%belz_tst_pd_live_missing%}" } }] } });
      expect(okData(await belz(["pd", "save", PAGE, "--overlay", orphan, "--force-validation", "--yes"]))).toMatchObject({ verify: { status: "match" } });
      const blocked = await belz(["pd", "publish", PAGE, "--yes"]);
      expect(errCode(blocked)).toBe("PD_VALIDATION_FAILED");
      const fix = file("fix.json", { nodes: { update: [{ id: NODE, props: { "[innerHTML]": `{%${VAR}%}` } }] } });
      okData(await belz(["pd", "save", PAGE, "--overlay", fix, "--yes"]));
      const pub = okData<{ publishedId: string; postPublishVersionId: number }>(await belz(["pd", "publish", PAGE, "--yes"]));
      published = true;
      publishedId = pub.publishedId;
      probeVersion = pub.postPublishVersionId;
      expect(probeVersion).toBeGreaterThan(0);
      const hist = okData<{ versions: Array<{ versionId: number }> }>(await belz(["pd", "history", "list", publishedId]));
      expect(hist.versions.map((v) => v.versionId)).toContain(probeVersion);
    }, T);

    test("history restore copies a published version into the DRAFT only", async () => {
      expect(probeVersion).toBeGreaterThan(0);
      const drift = file("drift.json", { variables: { update: [{ name: VAR, initialValue: "two" }] } });
      okData(await belz(["pd", "save", PAGE, "--overlay", drift, "--yes"]));
      const before = okData<{ totalVersions: number }>(await belz(["pd", "history", "list", publishedId!]));
      const r = okData(await belz(["pd", "history", "restore", PAGE, "--version", String(probeVersion), "--yes"]));
      expect(r).toMatchObject({ draftId: PAGE, restoredVersionId: probeVersion, verify: { status: "match" }, published: false });
      const after = okData<{ totalVersions: number }>(await belz(["pd", "history", "list", publishedId!]));
      expect(after.totalVersions).toBe(before.totalVersions); // no publish, no new history entry
    }, T);
  },
);
