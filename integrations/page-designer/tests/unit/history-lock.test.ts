// pd history show/diff/restore ownership + guard (PD-15) and the re-entrant,
// truthful lock (PD-20), over the in-memory PD server.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import history from "../../commands/history/index";
import lock from "../../commands/lock/index";
import save from "../../commands/save/index";
import { cleanInner, ENV, innerOf, page, startFakePd, type FakePd } from "./helpers/fake-pd";

const DRAFT = "d0000000000000000000000000000001";
const PUB = "p0000000000000000000000000000001";
const OTHER_PUB = "p0000000000000000000000000000009";

let pd: FakePd;
const run = (cmd: Parameters<typeof runCommand>[0], argv: string[]) => runCommand(cmd, argv, { env: ENV });
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

describe("pd history (PD-15)", () => {
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

  test("show accepts the owner id and its linked draft id; entity type from the server (F17)", async () => {
    for (const id of [PUB, DRAFT]) {
      const r = await run(history, ["show", id, "--version", "100"]);
      expect(r.envelope?.ok).toBe(true);
      expect(r.envelope?.data).toMatchObject({ ownerId: PUB, entityType: "PAGE", errorCount: 0 });
    }
  });

  test("restore of another page's version never touches this page", async () => {
    const r = await run(history, ["restore", PUB, "--version", "200", "--allow-published", "--yes"]);
    expect(r.envelope?.error?.code).toBe("PD_VERSION_PAGE_MISMATCH");
    expect(pd.log().some((l) => l.startsWith("PUT"))).toBe(false);
  });

  test("restore into a PUBLISHED owner needs --allow-published; then locks owner + draft", async () => {
    expect((await run(history, ["restore", DRAFT, "--version", "100", "--yes"])).envelope?.error?.code).toBe("PD_PUBLISHED_NO_DRAFT");
    expect(pd.log().some((l) => l.startsWith("PUT"))).toBe(false);

    const r = await run(history, ["restore", DRAFT, "--version", "100", "--allow-published", "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ ownerId: PUB, draftId: DRAFT, restoredVersionId: 100, newVersionId: 2 });
    const puts = pd.log().filter((l) => l.startsWith("PUT"));
    expect(puts).toEqual([
      `PUT /pages/lock/${PUB}?pageLockAction=ACQUIRED`,
      `PUT /pages/lock/${DRAFT}?pageLockAction=ACQUIRED`,
      "PUT /pages/revert/100",
      `PUT /pages/lock/${DRAFT}?pageLockAction=RELEASED`,
      `PUT /pages/lock/${PUB}?pageLockAction=RELEASED`,
    ]);
    expect(innerOf(pd.pages.get(PUB)!).variables!.userDefined![0]!.initialValue).toBe("old");
  });

  test("restore validates the version (diff-aware): a version that introduces an error is blocked", async () => {
    pd.versions.set(101, page(PUB, cleanInner({ layout: { id: "r", name: "span", unSelectable: true, children: [] } }), { status: "PUBLISHED", referenceId: DRAFT }));
    const r = await run(history, ["restore", PUB, "--version", "101", "--allow-published", "--yes"]);
    expect(r.envelope?.error?.code).toBe("PD_VALIDATION_FAILED");
    expect(pd.log().some((l) => l.startsWith("PUT"))).toBe(false);
  });
});

describe("pd lock (PD-20)", () => {
  const overlay = () => {
    const f = join(dir, "o.json");
    writeFileSync(f, JSON.stringify({ variables: { update: [{ name: "greeting", initialValue: "x" }] } }));
    return f;
  };

  test("a save inside a manual lock re-acquires the server lock (OTH-R4) but never releases it (PD-20)", async () => {
    expect((await run(lock, ["acquire", DRAFT])).envelope?.ok).toBe(true);
    const before = pd.log().length;
    const r = await run(save, [DRAFT, "--overlay", overlay(), "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(pd.log().slice(before).filter((l) => l.includes("/lock/"))).toEqual([`PUT /pages/lock/${DRAFT}?pageLockAction=ACQUIRED`]);
    const status = await run(lock, ["status"]);
    expect((status.envelope?.data as any).locks.map((l: any) => l.pageId)).toEqual([DRAFT]);
  });

  test("OTH-R4: a stale local record never skips the server lock — a 409 fails closed with a hint", async () => {
    expect((await run(lock, ["acquire", DRAFT])).envelope?.ok).toBe(true);
    pd.acquireStatus = 409; // someone else took it since
    const r = await run(save, [DRAFT, "--overlay", overlay(), "--yes"]);
    expect(r.envelope?.error).toMatchObject({ code: "PD_LOCKED", details: { staleLocalRecord: true } });
    expect(String(r.envelope?.error?.message)).toContain(`belz pd lock release ${DRAFT}`);
    expect(pd.log().filter((l) => /^PUT \/pages\/\w+$/.test(l))).toEqual([]);
  });

  test("a refused release is ok:false PD_LOCK_RELEASE_FAILED (it used to always succeed)", async () => {
    pd.releaseStatus = 409;
    const r = await run(lock, ["release", DRAFT]);
    expect(r.exitCode).toBe(1);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "PD_LOCK_RELEASE_FAILED" }, data: { released: false, recordKept: false } });
    pd.releaseStatus = 200;
    expect((await run(lock, ["release", DRAFT])).envelope?.data).toMatchObject({ released: true });
  });

  test("OTH-R9: a 5xx release keeps the local record; the lock file is written atomically with mode 0600", async () => {
    expect((await run(lock, ["acquire", DRAFT])).envelope?.ok).toBe(true);
    const file = join(BELZ_CONFIG_DIR, "pd-locks", `${ENV}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    pd.releaseStatus = 503;
    const r = await run(lock, ["release", DRAFT]);
    expect(r.envelope).toMatchObject({ ok: false, error: { code: "PD_LOCK_RELEASE_FAILED" }, data: { released: false, recordKept: true, httpStatus: 503 } });
    expect(((await run(lock, ["status"])).envelope?.data as any).locks.map((l: any) => l.pageId)).toEqual([DRAFT]);
    pd.releaseStatus = 404;
    expect((await run(lock, ["release", DRAFT])).envelope?.data).toMatchObject({ recordKept: false });
    expect(((await run(lock, ["status"])).envelope?.data as any).locks).toEqual([]);
  });
});
