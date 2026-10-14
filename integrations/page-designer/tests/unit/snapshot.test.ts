// `pd snapshot` — normalized, stable page snapshots and the semantic
// compare against the live page.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import snapshot from "../../commands/snapshot/index";
import { parsePage } from "../../lib/parser/index";
import { applyOverlay, withConfiguration } from "../../lib/serialize/index";
import { findNodes } from "../../lib/extract";
import {
  compareSnapshots,
  denormalizeValue,
  normalizeValue,
  pageFromSnapshot,
  serializeSnapshot,
  snapshotOf,
} from "../../lib/snapshot";
import { stableStringify } from "../../lib/page-diff";
import { ENV, startFakePd, type FakePd } from "./helpers/fake-pd";
import type { RawPageResponse } from "../../lib/types/wire";
import { loadReal } from "./helpers/real";

const STUDENT_APP = "4cba8f39eb92d136694dadc4e7f2a811";
const DRAFT_ADD = "4440a1a4628001dfb1b79aaec9dd55fe";

/** The raw body of `page` after an overlay. */
const edited = (raw: RawPageResponse, overlay: Parameters<typeof applyOverlay>[1]): RawPageResponse =>
  ({ ...raw, configuration: applyOverlay(parsePage(raw), overlay).rawConfigurationString }) as RawPageResponse;

describe("normalization", () => {
  const raw = loadReal(STUDENT_APP);
  const snap = snapshotOf(raw);
  const text = serializeSnapshot(snap);

  test("deterministic, keys sorted, no volatile / generated fields, multi-line strings as $lines", () => {
    expect(serializeSnapshot(snapshotOf(raw))).toBe(text);
    // a re-ordered, re-timestamped copy of the same page gives the same bytes
    const shuffled = { ...raw, versionId: 999, updatedAt: 1, id: "ffffffffffffffffffffffffffffffff", status: "PUBLISHED" } as RawPageResponse;
    expect(serializeSnapshot(snapshotOf(shuffled))).toBe(text);
    expect(text).not.toContain('"_elementId"');
    expect(text).not.toContain('"versionId"');
    expect(text).not.toContain('"updatedAt"');
    expect(text).toContain('"$lines"');
    expect(Object.keys(snap)).toEqual(["belzSnapshot", "entity", "config"]);
    const keys = Object.keys(snap.config as object);
    expect(keys).toEqual([...keys].sort());
    expect(snap.entity).toEqual({ name: "Student Application", entityType: "PAGE", relativeRoute: raw.relativeRoute as string, ...(snap.entity.dynamicRoute ? { dynamicRoute: snap.entity.dynamicRoute } : {}), ...(snap.entity.aliasName ? { aliasName: snap.entity.aliasName } : {}) });
  });

  test("$lines round-trips; the page rebuilt from a snapshot has the same model", () => {
    const v = { b: "one\r\ntwo", a: ["x\ny"], c: { $keep: 1 } };
    expect(denormalizeValue(normalizeValue(v))).toEqual({ a: ["x\ny"], b: "one\ntwo", c: { $keep: 1 } });
    const rebuilt = pageFromSnapshot(snap);
    const orig = parsePage(raw);
    expect(rebuilt.variables.map((x) => x.name)).toEqual(orig.variables.map((x) => x.name));
    expect(rebuilt.httpRequests.map((h) => h.callId)).toEqual(orig.httpRequests.map((h) => h.callId));
    expect(findNodes(rebuilt, "exp-layout-dialog").map((n) => n.id)).toEqual(findNodes(orig, "exp-layout-dialog").map((n) => n.id));
  });
});

describe("compareSnapshots (semantic)", () => {
  const raw = loadReal(STUDENT_APP);
  const base = snapshotOf(raw);
  const page = parsePage(raw);

  test("identical → nothing reported", () => {
    expect(compareSnapshots(base, snapshotOf(raw))).toEqual({
      identical: true, entityChanged: [], changes: {}, nodesMoved: [], childrenReordered: [], unclassified: false,
    });
  });

  test("variable / node / style / entity changes are named", () => {
    const node = findNodes(page, "labelSaveAndExit").find((m) => m.component === "span")!;
    const live = snapshotOf({
      ...edited(raw, {
        variables: { update: [{ name: "selectFirst", initialValue: "x" }] },
        nodes: { update: [{ id: node.id, props: { className: "changed" } }] },
        styles: { replace: ".latest-version .x{}" },
      }),
      relativeRoute: "moved-route",
    } as RawPageResponse);
    const c = compareSnapshots(base, live);
    expect(c.identical).toBe(false);
    expect(c.entityChanged).toEqual(["relativeRoute"]);
    expect(c.changes).toEqual({ variablesChanged: ["selectFirst"], nodesChanged: [node.id], stylesChanged: true });
  });

  test("a moved node and reordered children are reported, not as add/remove", () => {
    const inner = JSON.parse(raw.configuration as string);
    const kids = inner.layout.children as unknown[];
    [kids[0], kids[1]] = [kids[1], kids[0]];
    const c = compareSnapshots(base, snapshotOf({ ...raw, configuration: JSON.stringify(inner) } as RawPageResponse));
    expect(c.childrenReordered).toEqual([page.layout.nodeId]);
    expect(c.changes).toEqual({});
    // move one node to the root (same id, same props): nodesMoved, not add/remove
    const target = findNodes(page, "labelSaveAndExit").find((m) => m.component === "span")!;
    const inner2 = JSON.parse(raw.configuration as string);
    const detach = (n: { children?: Array<{ id?: string }> }): unknown => {
      const i = (n.children ?? []).findIndex((c) => c.id === target.id);
      if (i >= 0) return n.children!.splice(i, 1)[0];
      for (const c of n.children ?? []) {
        const hit = detach(c as never);
        if (hit) return hit;
      }
      return null;
    };
    inner2.layout.children.unshift(detach(inner2.layout));
    const m = compareSnapshots(base, snapshotOf({ ...raw, configuration: JSON.stringify(inner2) } as RawPageResponse));
    expect(m.nodesMoved).toEqual([target.id]);
    expect(m.changes).toEqual({});
    expect(m.childrenReordered).toEqual([]);
  });

  test("a draft vs its published sibling: only real config differences show", () => {
    const pub = loadReal("4bde22f76091a82364fda322eeeda597");
    const c = compareSnapshots(snapshotOf(loadReal(DRAFT_ADD)), snapshotOf(pub));
    expect(c.entityChanged).not.toContain("entityType");
    expect(c.unclassified).toBe(false);
    expect(stableStringify(snapshotOf(pub))).toBe(stableStringify(snapshotOf({ ...pub, versionId: 1, status: "DRAFT" } as RawPageResponse)));
  });
});


describe("pd snapshot command", () => {
  let pd: FakePd;
  const dir = scratchDir("wi-impl-pd-snapshot-");
  const run = (argv: string[]) => runCommand(snapshot, argv, { env: ENV });
  beforeEach(() => {
    rmSync(join(BELZ_CONFIG_DIR, "cache", "pages", ENV), { recursive: true, force: true });
    pd = startFakePd([{ ...loadReal(DRAFT_ADD), referenceId: null } as RawPageResponse]);
  });
  afterEach(() => pd.restore());

  test("--out writes the snapshot; --compare is ok while the page is unchanged", async () => {
    const file = join(dir, "nested", "add-student.json");
    const w = await run([DRAFT_ADD, "--out", file]);
    expect(w.envelope?.ok).toBe(true);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(w.envelope?.data).toMatchObject({ written: { bytes: Buffer.byteLength(text), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }, source: { id: DRAFT_ADD } });
    expect(w.envelope?.data).not.toHaveProperty("snapshot");
    const c = await run([DRAFT_ADD, "--compare", file]);
    expect(c.envelope?.ok).toBe(true);
    expect(c.exitCode).toBe(0);
    expect(c.envelope?.data).toMatchObject({ compare: { identical: true } });
  });

  test("a changed page → ok:false PD_SNAPSHOT_DIFFERS, exit 1, the diff in data (read fresh, not from cache)", async () => {
    const file = join(dir, "base.json");
    await run([DRAFT_ADD, "--out", file]);
    const cur = pd.pages.get(DRAFT_ADD)!;
    const page = parsePage(cur);
    const v = page.variables[0]!.name;
    pd.pages.set(DRAFT_ADD, { ...withConfiguration(page, JSON.parse(applyOverlay(page, { variables: { update: [{ name: v, initialValue: "changed" }] } }).rawConfigurationString)).raw as RawPageResponse, versionId: 7 });
    const c = await run([DRAFT_ADD, "--compare", file]);
    expect(c.envelope?.ok).toBe(false);
    expect(c.exitCode).toBe(1);
    expect(c.envelope?.error?.code).toBe("PD_SNAPSHOT_DIFFERS");
    expect(c.envelope?.data).toMatchObject({ compare: { identical: false, changes: { variablesChanged: [v] } } });
  });

  test("bad inputs: not a snapshot, missing file, --out with --compare", async () => {
    const bogus = join(dir, "bogus.json");
    writeFileSync(bogus, JSON.stringify({ hello: 1 }));
    expect((await run([DRAFT_ADD, "--compare", bogus])).envelope?.error?.code).toBe("INVALID_SNAPSHOT");
    expect((await run([DRAFT_ADD, "--compare", join(dir, "none.json")])).envelope?.error?.code).toBe("PD_FILE_NOT_FOUND");
    expect((await run([DRAFT_ADD, "--out", bogus, "--compare", bogus])).envelope?.error?.code).toBe("CONFLICTING_FLAGS");
  });

  test("without a flag the snapshot is returned in data", async () => {
    const r = await run([DRAFT_ADD]);
    expect(r.envelope?.data).toMatchObject({ snapshot: { belzSnapshot: 1, entity: { entityType: "PAGE" } } });
  });
});
