// pd history show/diff/restore ownership + guard and the re-entrant, truthful
// lock, over the in-memory PD server.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import { scratchDir } from "@belzabar/core/testing";
import history from "../../commands/history/index";
import lock from "../../commands/lock/index";
import save from "../../commands/save/index";
import { cleanInner, ENV, innerOf, page, startFakePd, type FakePd, run } from "./helpers/fake-pd";

const DRAFT = "d0000000000000000000000000000001";
const PUB = "p0000000000000000000000000000001";
const OTHER_PUB = "p0000000000000000000000000000009";

let pd: FakePd;
const dir = scratchDir("belz-pd-hist-");

beforeEach(() => {
  rmSync(join(BELZ_CONFIG_DIR, "pd-locks"), { recursive: true, force: true });
  pd = startFakePd([
    page(DRAFT, cleanInner(), { referenceId: PUB }),
    page(PUB, cleanInner(), { status: "PUBLISHED", referenceId: DRAFT }),
    page(OTHER_PUB, cleanInner(), { status: "PUBLISHED", referenceId: null, name: "other" }),
  ]);
  const old = cleanInner();
  old.variables.userDefined[0]!.initialValue = "old";
  pd.versions.set(100, page(PUB, old, { status: "PUBLISHED", referenceId: DRAFT, versionId: 100 }));
  pd.versions.set(200, page(OTHER_PUB, cleanInner(), { status: "PUBLISHED", name: "other", versionId: 200 }));
});
afterEach(() => pd.restore());

describe("pd history", () => {
  test("list on a DRAFT with no versions points at the published page (smoke doc mismatch)", async () => {
    const d = await run(history, ["list", DRAFT]);
    expect(d.envelope?.data).toMatchObject({ totalVersions: 0, publishedId: PUB });
    expect(String((d.envelope?.data as { hint?: string }).hint)).toContain(`belz pd history list ${PUB}`);
    const p = await run(history, ["list", PUB]);
    expect(p.envelope?.data).toMatchObject({ totalVersions: 1 });
    expect((p.envelope?.data as { publishedId?: string }).publishedId).toBeUndefined();
  });

  test("show refuses a version that belongs to another page", async () => {
    const r = await run(history, ["show", PUB, "--version", "200"]);
    expect(r.envelope?.error).toMatchObject({ code: "PD_VERSION_PAGE_MISMATCH", details: { ownerId: OTHER_PUB } });
    expect((await run(history, ["diff", PUB, "--from", "100", "--to", "200"])).envelope?.error?.code).toBe("PD_VERSION_PAGE_MISMATCH");
  });

  test("show accepts the owner id and its linked draft id; entity type from the server", async () => {
    for (const id of [PUB, DRAFT]) {
      const r = await run(history, ["show", id, "--version", "100"]);
      expect(r.envelope?.ok).toBe(true);
      expect(r.envelope?.data).toMatchObject({ ownerId: PUB, entityType: "PAGE", errorCount: 0 });
    }
  });

  test("restore of another page's version never touches this page", async () => {
    const r = await run(history, ["restore", PUB, "--version", "200", "--yes"]);
    expect(r.envelope?.error?.code).toBe("PD_VERSION_PAGE_MISMATCH");
    expect(pd.log().some((l) => l.startsWith("PUT"))).toBe(false);
  });

  test("restore rewrites the DRAFT via /pages/revert/<draftId>?versionId=, never the published row (verified live)", async () => {
    const pubBefore = pd.pages.get(PUB)!.configuration;
    const r = await run(history, ["restore", PUB, "--version", "100", "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({
      ownerId: PUB,
      draftId: DRAFT,
      restoredVersionId: 100,
      oldVersionId: 1,
      newVersionId: 2,
      verify: { status: "match" },
      versionDrift: null,
      published: false,
    });
    expect(pd.log().filter((l) => l.startsWith("PUT"))).toEqual([
      `PUT /pages/lock/${DRAFT}?pageLockAction=ACQUIRED`,
      `PUT /pages/revert/${DRAFT}?versionId=100`,
      `PUT /pages/lock/${DRAFT}?pageLockAction=RELEASED`,
    ]);
    // validated on a fresh read of the draft inside the lock
    const log = pd.log();
    expect(log.slice(log.indexOf(`PUT /pages/lock/${DRAFT}?pageLockAction=ACQUIRED`) + 1, log.indexOf(`PUT /pages/revert/${DRAFT}?versionId=100`))).toContain(`GET /pages/${DRAFT}`);
    expect(innerOf(pd.pages.get(DRAFT)!).variables!.userDefined![0]!.initialValue).toBe("old");
    expect(pd.pages.get(PUB)!.configuration).toBe(pubBefore);
    expect(((r.envelope?.meta.warnings ?? []) as string[]).some((w) => w.includes(`belz pd publish ${DRAFT}`))).toBe(true);
  });

  test("--allow-published is not a restore flag", async () => {
    const old = await run(history, ["restore", DRAFT, "--version", "100", "--allow-published", "--yes"]);
    expect(old.envelope?.error?.code).toBe("UNKNOWN_FLAG");
  });

  test("restore without --yes (llm) writes nothing; a published page with no draft is refused", async () => {
    expect((await run(history, ["restore", PUB, "--version", "100"])).envelope?.error?.code).toBe("CONFIRMATION_REQUIRED");
    pd.versions.set(300, page(OTHER_PUB, cleanInner(), { status: "PUBLISHED", name: "other", versionId: 300 }));
    expect((await run(history, ["restore", OTHER_PUB, "--version", "300", "--yes"])).envelope?.error?.code).toBe("PD_PUBLISHED_NO_DRAFT");
    expect(pd.log().some((l) => l.startsWith("PUT"))).toBe(false);
  });

  test("a soft-DELETED published owner still restores into its draft (the draft points back at it)", async () => {
    pd.pages.set(PUB, { ...pd.pages.get(PUB)!, status: "DELETED" as never });
    const r = await run(history, ["restore", DRAFT, "--version", "100", "--yes"]);
    expect(r.envelope?.data).toMatchObject({ ownerId: PUB, draftId: DRAFT, verify: { status: "match" } });
    expect(pd.log().filter((l) => l.startsWith("PUT /pages/revert/"))).toEqual([`PUT /pages/revert/${DRAFT}?versionId=100`]);
  });

  test("a revert whose read-back is not the version is ok:false PD_RESTORE_VERIFY_FAILED", async () => {
    pd.getOverride = (id) => (id === DRAFT && pd.log().some((l) => l.startsWith("PUT /pages/revert/")) ? page(DRAFT, cleanInner(), { referenceId: PUB, versionId: 2 }) : undefined);
    const r = await run(history, ["restore", PUB, "--version", "100", "--yes"]);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "PD_RESTORE_VERIFY_FAILED" }, data: { verify: { status: "mismatch" } } });
  });

  test("restore validates the version (diff-aware): a version that introduces an error is blocked", async () => {
    pd.versions.set(101, page(PUB, cleanInner({ layout: { id: "r", name: "span", unSelectable: true, children: [] } }), { status: "PUBLISHED", referenceId: DRAFT }));
    const r = await run(history, ["restore", PUB, "--version", "101", "--yes"]);
    expect(r.envelope?.error?.code).toBe("PD_VALIDATION_FAILED");
    expect(pd.log().some((l) => l.startsWith("PUT"))).toBe(false);
  });
});

describe("pd lock", () => {
  const overlay = () => {
    const f = join(dir, "o.json");
    writeFileSync(f, JSON.stringify({ variables: { update: [{ name: "greeting", initialValue: "x" }] } }));
    return f;
  };

  test("a save inside a manual lock — the re-acquire is a 400, pageLockDetails says it is mine — proceeds and never releases (verified live)", async () => {
    expect((await run(lock, ["acquire", DRAFT])).envelope?.ok).toBe(true);
    const before = pd.log().length;
    const r = await run(save, [DRAFT, "--overlay", overlay(), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(pd.log().slice(before).filter((l) => l.includes("/lock/"))).toEqual([`PUT /pages/lock/${DRAFT}?pageLockAction=ACQUIRED`]);
    expect(pd.locks.get(DRAFT)).toBe("me");
    const status = await run(lock, ["status"]);
    expect((status.envelope?.data as any).locks.map((l: any) => l.pageId)).toEqual([DRAFT]);
  });

  test("a lock I hold WITHOUT a manual record (another run / my PD editor) is reused and left held, with a note", async () => {
    pd.locks.set(DRAFT, "me");
    const r = await run(save, [DRAFT, "--overlay", overlay(), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(pd.log().filter((l) => l.includes("RELEASED"))).toEqual([]);
    expect(pd.locks.get(DRAFT)).toBe("me");
  });

  test("a stale local record never skips the server lock — someone else's lock fails closed with a hint", async () => {
    expect((await run(lock, ["acquire", DRAFT])).envelope?.ok).toBe(true);
    pd.locks.set(DRAFT, "user-0002"); // someone else took it since
    const r = await run(save, [DRAFT, "--overlay", overlay(), "--yes"]);
    expect(r.envelope?.error).toMatchObject({ code: "PD_LOCKED", details: { staleLocalRecord: true, holder: { userName: "user-0002" } } });
    expect(String(r.envelope?.error?.message)).toContain(`belz pd lock release ${DRAFT}`);
    expect(pd.log().filter((l) => /^PUT \/pages\/\w+$/.test(l))).toEqual([]);
  });

  test("someone else's lock without a manual record: PD_LOCKED naming the holder, nothing written", async () => {
    pd.locks.set(DRAFT, "user-0002");
    const r = await run(save, [DRAFT, "--overlay", overlay(), "--yes"]);
    expect(r.envelope?.error).toMatchObject({ code: "PD_LOCKED", details: { status: 409, holder: { userName: "user-0002", validTill: "2099-01-01 00:00:00" } } });
    expect(String(r.envelope?.error?.message)).toContain("user-0002");
  });

  test("lock acquire on a lock I already hold is ok (alreadyHeld); status <id> shows the server's view", async () => {
    pd.locks.set(DRAFT, "me");
    expect((await run(lock, ["acquire", DRAFT])).envelope?.data).toMatchObject({ alreadyHeld: true });
    expect((await run(lock, ["status", DRAFT])).envelope?.data).toMatchObject({ server: { pageId: DRAFT, locked: true, byMe: true, userName: "Me" } });
    pd.locks.set(DRAFT, "user-0002");
    expect((await run(lock, ["status", DRAFT])).envelope?.data).toMatchObject({ server: { locked: true, byMe: false, userName: "user-0002" } });
    pd.locks.delete(DRAFT);
    expect((await run(lock, ["status", DRAFT])).envelope?.data).toMatchObject({ server: { locked: false, byMe: null } });
  });

  test("a release that releases nothing (200 false) is ok:false PD_LOCK_RELEASE_FAILED; a real release is ok", async () => {
    const r = await run(lock, ["release", DRAFT]);
    expect(r.exitCode).toBe(1);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "PD_LOCK_RELEASE_FAILED" }, data: { released: false, httpStatus: 200, recordKept: false } });
    expect(String(r.envelope?.error?.message)).toContain("you do not hold its lock");
    expect((await run(lock, ["acquire", DRAFT])).envelope?.ok).toBe(true);
    expect((await run(lock, ["release", DRAFT])).envelope?.data).toMatchObject({ released: true });
    expect(pd.locks.has(DRAFT)).toBe(false);
  });

  test("a 5xx release keeps the local record; the lock file is written atomically with mode 0600", async () => {
    expect((await run(lock, ["acquire", DRAFT])).envelope?.ok).toBe(true);
    const file = join(BELZ_CONFIG_DIR, "pd-locks", `${ENV}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    pd.releaseStatus = 503;
    const r = await run(lock, ["release", DRAFT]);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "PD_LOCK_RELEASE_FAILED" }, data: { released: null, recordKept: true, httpStatus: 503 } });
    expect(((await run(lock, ["status"])).envelope?.data as any).locks.map((l: any) => l.pageId)).toEqual([DRAFT]);
    pd.releaseStatus = 200; // the lock is still mine: a real release drops the record
    expect((await run(lock, ["release", DRAFT])).envelope?.data).toMatchObject({ released: true, recordKept: false });
    expect(((await run(lock, ["status"])).envelope?.data as any).locks).toEqual([]);
  });
});
