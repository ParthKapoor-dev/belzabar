// K8: `ad save` (and --dry-run) checks a rename against every name and alias
// in the category (the category listing, shaped like the live
// /automation/methods rows) and names the method holding it.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import saveCommand from "../../commands/save/index";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import { compiledCacheRoutes, fakeAdEnv, v2Store } from "./helpers/fake-ad";

const DIR = `${import.meta.dir}/../fixtures/real-v2`;
const U = "41bb1b438875bd8b994196db1f12b7c2";
const PUB = "0000000000000000000000000000beef";
const OTHER = "4f65cac78c351b9597f389dcb9ba4214";
const base = (): V2MethodResponse => structuredClone(require(`${DIR}/${U}.v2.json`));
const NAME = String(base().name);

/** A listing row as the server sends it: the name lives in jsonDefinition, the alias beside it. */
const row = (uuid: string, name: string, alias: string, state = "DRAFT", referenceId: string | null = null) => ({
  uuid,
  aliasName: alias,
  name: null,
  referenceId,
  automationState: state,
  state,
  version: 1,
  jsonDefinition: JSON.stringify({ name, services: [] }),
});

const ad = fakeAdEnv();
afterEach(() => ad.restore());

function wire(listing: unknown[] | number, opts: { published?: boolean } = {}) {
  const s = v2Store(U, base());
  if (opts.published) s.stored.metadata.referenceId = `${PUB}    `;
  ad.install([
    ...s.routes,
    { method: "GET", url: `/rest/api/automation/chain/${U}`, response: { uuid: U, jsonDefinition: "{}" } },
    {
      method: "GET",
      url: /\/rest\/api\/automation\/methods\?categoryUuid=/,
      response: () => (typeof listing === "number" ? new Response("down", { status: listing }) : { currentOffset: listing.length, methodList: listing }),
    },
    ...compiledCacheRoutes(),
  ]);
  return s;
}

const run = (overlay: unknown, ...extra: string[]) => {
  const p = join(scratchDir("ad-save-name"), `o-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(overlay));
  return runCommand(saveCommand, [p, "--uuid", U, "--yes", ...extra], { env: "t-dev" });
};

describe("K8: rename onto a taken name or alias", () => {
  test("dry run: the new name is another method's alias (it was renamed) → valid:false, names the holder", async () => {
    wire([row(OTHER, "orders.list.renamed", "orders.list"), row(U, NAME, NAME)]);
    const r = await run({ name: "orders.list" }, "--dry-run");
    const d = r.envelope!.data as any;
    expect(d.valid).toBe(false);
    expect(d.nameConflict).toEqual({ name: "orders.list", matched: "alias", holder: { uuid: OTHER, state: "DRAFT", name: "orders.list.renamed", alias: "orders.list" } });
    expect(((r.envelope?.meta?.warnings ?? []) as string[]).join("\n")).toContain(`'orders.list' is already the alias of DRAFT ${OTHER} (name 'orders.list.renamed', alias 'orders.list')`);
  });

  test("save: refused before anything is POSTed (AD_METHOD_EXISTS)", async () => {
    const s = wire([row(OTHER, "orders.list", "orders.list", "PUBLISHED", "4aaa0000000000000000000000000000")]);
    const r = await run({ name: "orders.list" });
    expect(r.envelope?.error?.code).toBe("AD_METHOD_EXISTS");
    expect(r.envelope?.error?.message).toContain(`is already the name of PUBLISHED ${OTHER}`);
    expect(s.posts).toHaveLength(0);
  });

  test("matching is exact (case-sensitive, as the server); the method's own rows (draft, published copy) never conflict", async () => {
    wire([row(OTHER, "orders.list", "orders.list"), row(PUB, "orders.old", "orders.old", "PUBLISHED", U)], { published: true });
    expect((await run({ name: "Orders.List" }, "--dry-run")).envelope!.data).toMatchObject({ valid: true });
    const own = (await run({ name: "orders.old" }, "--dry-run")).envelope!.data as any;
    expect(own.nameConflict).toBeUndefined();
  });

  test("no rename: no listing read; a failed listing only warns", async () => {
    wire([row(OTHER, NAME, NAME)]);
    await run({ summary: "s" }, "--dry-run");
    expect(ad.ff.requests.some((q) => q.url.includes("/automation/methods?"))).toBe(false);
    ad.restore();
    wire(503);
    const r = await run({ name: "orders.new" }, "--dry-run");
    expect((r.envelope!.data as any).nameConflict).toBeUndefined();
    expect(((r.envelope?.meta?.warnings ?? []) as string[]).join("\n")).toContain("Could not check whether 'orders.new' is free");
  });
});
