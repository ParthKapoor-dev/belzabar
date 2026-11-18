// F7 (B111, B122): a page's deploy hosts are readable (`show` hostIds, `pd
// hosts`) and reusable (`publish --hosts-from-current`), over the fake server.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import hosts from "../../commands/hosts/index";
import publish from "../../commands/publish/index";
import show from "../../commands/show/index";
import { hostIdsOf } from "../../lib/extract";
import { cleanInner, ENV, page, run, startFakePd, type FakePd } from "./helpers/fake-pd";

const DRAFT = "d0000000000000000000000000000001";
const PUB = "b0000000000000000000000000000001";
const NEW_DRAFT = "d0000000000000000000000000000002";
const BARE = "d0000000000000000000000000000003";

let pd: FakePd;
beforeEach(() => {
  rmSync(join(BELZ_CONFIG_DIR, "cache", "pages", ENV), { recursive: true, force: true });
  pd = startFakePd([
    page(DRAFT, cleanInner(), { referenceId: PUB, hostIds: "99" }),
    page(PUB, cleanInner(), { status: "PUBLISHED", referenceId: DRAFT, hostIds: "22,99" }),
    page(NEW_DRAFT, cleanInner(), { hostIds: "99" }),
    page(BARE, cleanInner()),
  ]);
});
afterEach(() => pd.restore());

const publishCall = () => pd.log().find((l) => l.includes("/publish?"));

test("hostIdsOf reads the wire's comma string", () => {
  expect(hostIdsOf(page("x", {}, { hostIds: "22, 99" }))).toEqual(["22", "99"]);
  expect(hostIdsOf(page("x", {}))).toEqual([]);
});

describe("read", () => {
  test("pd show prints the row's hostIds", async () => {
    const data = (await run(show, [PUB, "--force"])).envelope!.data as any;
    expect(data.summary.hostIds).toEqual(["22", "99"]);
  });

  test("pd hosts lists the deployable hosts, sorted by id", async () => {
    const r = await run(hosts, []);
    expect(r.envelope!.data).toEqual({
      count: 2,
      hosts: [
        { id: 22, domain: "public.example.test", nickname: "PUB", description: "Public site" },
        { id: 99, domain: "staff.example.test", nickname: "STF", description: "Staff site" },
      ],
    });
    expect(hosts.writes).toBeFalsy();
  });
});

describe("pd publish --hosts-from-current", () => {
  test("deploys to the published row's hosts", async () => {
    const r = await run(publish, [DRAFT, "--hosts-from-current", "--yes"]);
    expect(r.envelope!.data).toMatchObject({ hostIds: ["22", "99"], hostIdsSource: "published" });
    expect(publishCall()).toContain("hostIds=22%2C99");
  });

  test("a never-published draft reuses its own hosts", async () => {
    const r = await run(publish, [NEW_DRAFT, "--hosts-from-current", "--yes"]);
    expect(r.envelope!.data).toMatchObject({ hostIds: ["99"], hostIdsSource: "draft" });
  });

  test("no current hosts → PD_NO_CURRENT_HOSTS before anything is published", async () => {
    const r = await run(publish, [BARE, "--hosts-from-current", "--yes"]);
    expect(r.envelope!.error).toMatchObject({ code: "PD_NO_CURRENT_HOSTS", message: expect.stringContaining("wi-impl pd hosts") });
    expect(publishCall()).toBeUndefined();
  });

  test("--host still wins as before (source flag); no flag = publish only", async () => {
    expect((await run(publish, [DRAFT, "--host", "5", "--yes"])).envelope!.data).toMatchObject({ hostIds: ["5"], hostIdsSource: "flag" });
    expect((await run(publish, [DRAFT, "--yes"])).envelope!.data).toMatchObject({ hostIds: [], hostIdsSource: "none" });
  });
});
