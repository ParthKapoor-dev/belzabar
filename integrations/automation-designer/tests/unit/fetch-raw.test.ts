// `ad fetch --raw` returns the wire body once as data.raw (not the whole
// hydrated method, whose own `raw` would carry the wire body a second time).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runCommand } from "@belzabar/core/testing";
import fetchCommand from "../../commands/fetch/index";
import { definitionRoute, fakeAdEnv } from "./helpers/fake-ad";

const FIX = join(import.meta.dir, "../fixtures");
const UUID = "4f6331f11208e5ccc8ddaaad20727664";
const wireBody = () => JSON.parse(readFileSync(join(FIX, "real-v1", `${UUID}.v1.json`), "utf8"));

const ad = fakeAdEnv({ env: "t-fetch", quiet: false });
afterEach(() => ad.restore());

test("fetch --raw: data.raw is the wire body, once", async () => {
  ad.install([
    { method: "GET", url: `/rest/api/automation/chain/${UUID}`, response: wireBody() },
    definitionRoute((d, id) => (d.id = id)),
  ]);
  const r = await runCommand(fetchCommand, [UUID, "--raw"], { env: "t-fetch" });
  expect(r.envelope?.ok).toBe(true);
  const data = r.envelope?.data as { raw: unknown; method: { uuid: string } };
  expect(data.method.uuid).toBe(UUID);
  expect(data.raw).toEqual(wireBody());
  const plain = await runCommand(fetchCommand, [UUID], { env: "t-fetch" });
  expect((plain.envelope?.data as { raw?: unknown }).raw).toBeUndefined();
});
