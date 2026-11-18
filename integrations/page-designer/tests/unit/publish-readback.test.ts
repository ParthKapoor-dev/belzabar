// F6 (B111): a published version's content can be read back — `history show
// --out` writes it as a snapshot file, and `publish` compares the new version
// with the draft it came from.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import { scratchDir } from "@belzabar/core/testing";
import history from "../../commands/history/index";
import publish from "../../commands/publish/index";
import snapshot from "../../commands/snapshot/index";
import { cleanInner, ENV, page, run, startFakePd, type FakePd } from "./helpers/fake-pd";

const DRAFT = "d0000000000000000000000000000001";
const PUB = "b0000000000000000000000000000001";
const dir = scratchDir("wi-impl-pd-readback-");

let pd: FakePd;
beforeEach(() => {
  rmSync(join(BELZ_CONFIG_DIR, "cache", "pages", ENV), { recursive: true, force: true });
  pd = startFakePd([page(DRAFT, cleanInner(), { referenceId: PUB }), page(PUB, cleanInner(), { status: "PUBLISHED", referenceId: DRAFT })]);
});
afterEach(() => pd.restore());

describe("pd publish read-back", () => {
  test("the new version matches the draft that was published", async () => {
    const r = await run(publish, [DRAFT, "--yes"]);
    expect(r.envelope!.ok).toBe(true);
    expect(r.envelope!.data).toMatchObject({ postPublishVersionId: 900, readBack: { status: "match", versionId: 900 } });
    expect(pd.log()).toContain("GET /pages/version/900");
  });

  test("a version that holds something else → PD_PUBLISH_VERIFY_FAILED with the comparison", async () => {
    pd.onPublish = (inner) => {
      (inner.variables as { userDefined: Array<{ initialValue: unknown }> }).userDefined[0]!.initialValue = "other";
    };
    const r = await run(publish, [DRAFT, "--yes"]);
    expect(r.exitCode).toBe(1);
    expect(r.envelope).toMatchObject({
      ok: false,
      error: { code: "PD_PUBLISH_VERIFY_FAILED" },
      data: { readBack: { status: "mismatch", versionId: 900, compare: { changes: { variablesChanged: ["greeting"] } } } },
    });
  });

  test("an unreadable version is reported, not a failure", async () => {
    const real = pd.versions.set.bind(pd.versions);
    pd.versions.set = ((k: number, v) => (k === 900 ? pd.versions : real(k, v))) as typeof pd.versions.set;
    const r = await run(publish, [DRAFT, "--yes"]);
    expect(r.envelope!.ok).toBe(true);
    expect((r.envelope!.data as any).readBack).toEqual({ status: "unavailable", versionId: 900 });
  });
});

describe("pd history show --out", () => {
  test("writes the version's full config as a snapshot that pd snapshot --compare reads", async () => {
    await run(publish, [DRAFT, "--yes"]);
    const out = join(dir, "v900.json");
    const r = await run(history, ["show", PUB, "--version", "900", "--out", out]);
    expect((r.envelope!.data as any).written).toMatchObject({ path: out, bytes: expect.any(Number), sha256: expect.any(String) });
    const file = JSON.parse(readFileSync(out, "utf8"));
    expect(file).toMatchObject({ belzSnapshot: 1, entity: { name: `page-${DRAFT}` } });
    expect(file.config.variables.userDefined[0]).toMatchObject({ name: "greeting", initialValue: "hi" });
    expect((await run(snapshot, [DRAFT, "--compare", out])).envelope!.ok).toBe(true);
  });
});
