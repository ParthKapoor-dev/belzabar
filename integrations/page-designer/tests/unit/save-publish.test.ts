// Command-level tests for the PD write paths over an in-memory PD server
// (fakeFetch): save (PD-4, PD-6, PD-3, PD-17), publish (PD-6, s0-review cache
// invalidation), preflight / validate exit codes (PD-8 / F18).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import save from "../../commands/save/index";
import publish from "../../commands/publish/index";
import preflight from "../../commands/preflight/index";
import validate from "../../commands/validate/index";
import { cleanInner, ENV, innerOf, page, startFakePd, type FakePd } from "./helpers/fake-pd";

const DRAFT = "d0000000000000000000000000000001";
const PUB = "p0000000000000000000000000000001";
const LONE_PUB = "p0000000000000000000000000000002";

let pd: FakePd;
const dir = scratchDir("belz-pd-save-");
let n = 0;
function overlayFile(overlay: unknown): string {
  const p = join(dir, `overlay-${++n}.json`);
  writeFileSync(p, JSON.stringify(overlay));
  return p;
}
const run = (cmd: Parameters<typeof runCommand>[0], argv: string[]) => runCommand(cmd, argv, { env: ENV });

beforeEach(() => {
  rmSync(join(BELZ_CONFIG_DIR, "cache", "pages", ENV), { recursive: true, force: true });
  pd = startFakePd([
    page(DRAFT, cleanInner(), { referenceId: PUB }),
    page(PUB, cleanInner(), { status: "PUBLISHED", referenceId: DRAFT }),
    page(LONE_PUB, cleanInner(), { status: "PUBLISHED", referenceId: null }),
  ]);
});
afterEach(() => pd.restore());

const saves = () => pd.log().filter((l) => /^PUT \/pages\/\w+$/.test(l));
const locks = () => pd.log().filter((l) => l.startsWith("PUT /pages/lock/"));

describe("pd save", () => {
  const upd = { variables: { update: [{ name: "greeting", initialValue: "hello" }] } };

  test("--dry-run plans and validates without locking or writing", async () => {
    const r = await run(save, [DRAFT, "--overlay", overlayFile(upd), "--dry-run"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ strategy: "partial", dryRun: true, operationsCount: 1, diffSummary: { variablesChanged: ["greeting"] } });
    expect(locks()).toEqual([]);
    expect(saves()).toEqual([]);
  });

  test("a real save: lock → fresh GET inside the lock → PUT → read-back → release (PD-4)", async () => {
    const r = await run(save, [DRAFT, "--overlay", overlayFile(upd), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    const log = pd.log();
    const acquire = log.indexOf(`PUT /pages/lock/${DRAFT}?pageLockAction=ACQUIRED`);
    const put = log.indexOf(`PUT /pages/${DRAFT}`);
    const release = log.indexOf(`PUT /pages/lock/${DRAFT}?pageLockAction=RELEASED`);
    expect(acquire).toBeGreaterThan(-1);
    expect(log.slice(acquire + 1, put)).toContain(`GET /pages/${DRAFT}`); // fetched inside the lock
    expect(release).toBeGreaterThan(put);
    expect(r.envelope?.data).toMatchObject({ strategy: "partial", result: { oldVersionId: 1, newVersionId: 2 }, verify: { status: "match" }, versionDrift: null });
    expect(innerOf(pd.pages.get(DRAFT)!).variables!.userDefined![0]!.initialValue).toBe("hello");
  });

  test("a concurrent edit between the first read and the lock is kept, and reported (PD-4)", async () => {
    pd.onAcquire = (id) => {
      const p = pd.pages.get(id)!;
      const inner = innerOf(p);
      // Another editor inserted a variable at index 0 — a stale raw index would now hit the wrong entry.
      inner.variables!.userDefined!.unshift({ name: "inserted", type: "String", initialValue: "x" });
      pd.pages.set(id, { ...p, configuration: JSON.stringify(inner), versionId: 7 });
    };
    const r = await run(save, [DRAFT, "--overlay", overlayFile(upd), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ versionDrift: { from: 1, to: 7 }, result: { oldVersionId: 7, newVersionId: 8 } });
    const ud = innerOf(pd.pages.get(DRAFT)!).variables!.userDefined!;
    expect(ud.map((v) => [v.name, v.initialValue])).toEqual([
      ["inserted", "x"],
      ["greeting", "hello"],
      ["other", "o"],
    ]);
  });

  test("an edit that introduces a validator error is refused before any lock", async () => {
    const bad = { elements: { operations: [{ key: "layout.children[0].props.[innerHTML]", value: "{%typo%}", operation: "UPDATE", dataType: "STRING" }] } };
    const r = await run(save, [DRAFT, "--overlay", overlayFile(bad), "--yes"]);
    expect(r.envelope?.error?.code).toBe("PD_VALIDATION_FAILED");
    expect(locks()).toEqual([]);
  });

  test("PD-6: --force-validation bypasses validation; --force is a deprecated alias of it", async () => {
    const bad = { elements: { operations: [{ key: "layout.children[0].props.[innerHTML]", value: "{%typo%}", operation: "UPDATE", dataType: "STRING" }] } };
    const a = await run(save, [DRAFT, "--overlay", overlayFile(bad), "--force-validation", "--yes"]);
    expect(a.envelope?.ok).toBe(true);
    expect((a.envelope?.data as any).bypassedErrors.map((e: any) => e.code)).toEqual(["ORPHAN_BINDING"]);
    const b = await run(save, [DRAFT, "--overlay", overlayFile(bad), "--force", "--yes"]);
    expect(b.envelope?.ok).toBe(true);
    expect(((b.envelope?.meta.warnings ?? []) as string[]).some((w) => w.includes("--force is deprecated"))).toBe(true);
  });

  test("PD-6: a PUBLISHED page with no draft needs --allow-published; --force no longer allows it", async () => {
    const f = overlayFile(upd);
    expect((await run(save, [LONE_PUB, "--overlay", f, "--yes"])).envelope?.error?.code).toBe("PD_PUBLISHED_NO_DRAFT");
    expect((await run(save, [LONE_PUB, "--overlay", f, "--force", "--yes"])).envelope?.error?.code).toBe("PD_PUBLISHED_NO_DRAFT");
    const ok = await run(save, [LONE_PUB, "--overlay", f, "--allow-published", "--yes"]);
    expect(ok.envelope?.ok).toBe(true);
    expect(saves()).toEqual([`PUT /pages/${LONE_PUB}`]);
  });

  test("a PUBLISHED input writes to its linked draft", async () => {
    const r = await run(save, [PUB, "--overlay", overlayFile(upd), "--yes"]);
    expect(r.envelope?.data).toMatchObject({ draftId: DRAFT, publishedId: PUB, switchedFromPublished: true });
    expect(saves()).toEqual([`PUT /pages/${DRAFT}`]);
  });

  test("--llm without --yes → CONFIRMATION_REQUIRED, nothing written", async () => {
    const r = await run(save, [DRAFT, "--overlay", overlayFile(upd)]);
    expect(r.envelope?.error?.code).toBe("CONFIRMATION_REQUIRED");
    expect(locks()).toEqual([]);
  });

  test("PD-3: an http handler / transform edit is saved (it used to be a silent 0-op partial save)", async () => {
    pd.pages.set(DRAFT, page(DRAFT, cleanInner({
      httpRequests: { generated: [], userDefined: [{ meta: { serviceCall: { callId: "c1", label: "c1" } }, handler: { success: [], error: [] }, request: { url: "/u" }, trigger: [] }] },
    }), { referenceId: PUB }));
    const overlay = { httpRequests: { update: [{ callId: "c1", handler: { error: [["{%greeting%}", "e"]] }, responseTransformSpec: "(d)=>d" }] } };
    const r = await run(save, [DRAFT, "--overlay", overlayFile(overlay), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).operationsCount).toBe(2);
    const call = innerOf(pd.pages.get(DRAFT)!).httpRequests!.userDefined![0]!;
    expect(call.handler!.error).toEqual([["{%greeting%}", "e"]]);
    expect(call.responseTransformSpec).toBe("(d)=>d");
  });

  test("OTH-R1: a binding-prop edit ([innerHTML]) is a FULL save — its partial key shape is unverified", async () => {
    const edit = { nodes: { update: [{ id: "n1", props: { "[innerHTML]": "{%other%}" } }] } };
    const r = await run(save, [DRAFT, "--overlay", overlayFile(edit), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({
      strategy: "full",
      fullSaveReason: "unverified partial-op key shape: layout.children[0].props.[innerHTML]",
      verify: { status: "match" },
    });
    const put = pd.ff.requests.find((q) => q.method === "PUT" && /\/pages\/d0+1$/.test(new URL(q.url).pathname))!;
    expect(put.json()).toMatchObject({ partialUpdate: false });
    expect((innerOf(pd.pages.get(DRAFT)!).layout as any).children[0].props["[innerHTML]"]).toBe("{%other%}");
  });

  test("OTH-R1: the fake server rejects undocumented partial keys (not circular with belz's replay)", async () => {
    const { applyWireOps } = await import("./helpers/fake-pd");
    const op = (key: string) => ({ key, value: "x", operation: "UPDATE", dataType: "STRING" });
    expect(applyWireOps(cleanInner(), [op("layout.children[0].props.[innerHTML]")])).toBeNull();
    expect((applyWireOps(cleanInner(), [op("layout.children[0].props.title")]) as any).layout.children[0].props.title).toBe("x");
  });

  test("an edit that changes nothing performs no write", async () => {
    const r = await run(save, [DRAFT, "--overlay", overlayFile({ variables: { update: [{ name: "greeting", initialValue: "hi" }] } }), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(saves()).toEqual([]);
  });

  test("full save sends the page's own config with only the edit applied", async () => {
    const r = await run(save, [DRAFT, "--overlay", overlayFile({ variables: { remove: ["other"] } }), "--yes"]);
    expect(r.envelope?.data).toMatchObject({ strategy: "full", fullSaveReason: "variables.remove", verify: { status: "match" } });
    const expected = cleanInner();
    expected.variables.userDefined.pop();
    expect(innerOf(pd.pages.get(DRAFT)!)).toEqual(expected);
  });

  test("PD-17 / overlay targets: missing file, bad JSON, unknown variable are coded errors", async () => {
    expect((await run(save, [DRAFT, "--overlay", join(dir, "absent.json"), "--yes"])).envelope?.error?.code).toBe("PD_FILE_NOT_FOUND");
    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{nope");
    expect((await run(save, [DRAFT, "--overlay", badJson, "--yes"])).envelope?.error?.code).toBe("INVALID_OVERLAY");
    const unknown = overlayFile({ variables: { update: [{ name: "nope", initialValue: 1 }] } });
    expect((await run(save, [DRAFT, "--overlay", unknown, "--yes"])).envelope?.error?.code).toBe("PD_OVERLAY_INVALID");
    expect(locks()).toEqual([]);
  });

  test("a failed PUT still releases the lock and surfaces PD_API_ERROR", async () => {
    pd.saveStatus = 500;
    const r = await run(save, [DRAFT, "--overlay", overlayFile(upd), "--yes"]);
    expect(r.envelope?.error?.code).toBe("PD_API_ERROR");
    expect(locks()).toEqual([`PUT /pages/lock/${DRAFT}?pageLockAction=ACQUIRED`, `PUT /pages/lock/${DRAFT}?pageLockAction=RELEASED`]);
  });
});

describe("pd publish", () => {
  function seedCache(id: string) {
    const d = join(BELZ_CONFIG_DIR, "cache", "pages", ENV);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${id}.json`), JSON.stringify({ savedAt: Date.now(), data: { id } }));
    return join(d, `${id}.json`);
  }

  test("drops the cache of BOTH the draft and the published page (s0-review)", async () => {
    const draftFile = seedCache(DRAFT);
    const pubFile = seedCache(PUB);
    const r = await run(publish, [DRAFT, "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ draftId: DRAFT, publishedId: PUB, postPublishVersionId: 900 });
    expect(existsSync(draftFile)).toBe(false);
    expect(existsSync(pubFile)).toBe(false);
  });

  test("validates the draft: errors block unless --force-validation (--force = deprecated alias)", async () => {
    pd.pages.set(DRAFT, page(DRAFT, cleanInner({ layout: { id: "r", name: "div", children: [] } }), { referenceId: PUB }));
    expect((await run(publish, [DRAFT, "--yes"])).envelope?.error?.code).toBe("PD_VALIDATION_FAILED");
    expect(pd.log().some((l) => l.includes("/publish"))).toBe(false);
    const r = await run(publish, [DRAFT, "--force-validation", "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).bypassedErrors.map((e: any) => e.code)).toEqual(["ROOT_LAYOUT_MALFORMED"]);
  });

  test("PD-6: a PUBLISHED page without a draft needs --allow-published", async () => {
    expect((await run(publish, [LONE_PUB, "--force", "--yes"])).envelope?.error?.code).toBe("PD_PUBLISHED_NO_DRAFT");
    expect((await run(publish, [LONE_PUB, "--allow-published", "--yes"])).envelope?.ok).toBe(true);
  });
});

describe("preflight / validate exit codes (PD-8 / F18)", () => {
  test("a page with validator errors → ok:false, exit 1, report in data", async () => {
    pd.pages.set(DRAFT, page(DRAFT, cleanInner({ layout: { id: "r", name: "div", children: [] } })));
    const p = await run(preflight, [DRAFT]);
    expect(p.exitCode).toBe(1);
    expect(p.envelope).toMatchObject({ ok: false, error: { code: "PD_PREFLIGHT_FAILED" }, data: { validation: { errorCount: 1 } } });
    const v = await run(validate, [DRAFT]);
    expect(v.exitCode).toBe(1);
    expect(v.envelope).toMatchObject({ ok: false, error: { code: "PD_VALIDATION_FAILED" }, data: { errorCount: 1, entityType: "PAGE" } });
  });

  test("a clean page → ok:true, exit 0; an overlay is validated like save (diff-aware)", async () => {
    expect((await run(preflight, [DRAFT])).exitCode).toBe(0);
    expect((await run(validate, [DRAFT])).exitCode).toBe(0);
    const bad = overlayFile({ variables: { add: [{ name: "arr", type: "Any", initialValue: [1] }] } });
    const r = await run(preflight, [DRAFT, "--overlay", bad]);
    expect(r.exitCode).toBe(1);
    expect(r.envelope?.data).toMatchObject({ overlayStrategy: "full", fullSaveReason: "variables.add", diffSummary: { variablesAdded: ["arr"] } });
  });
});
