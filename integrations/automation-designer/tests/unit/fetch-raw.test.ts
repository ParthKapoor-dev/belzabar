// `ad fetch --raw` returns the wire body once as data.raw (smoke --llm envelope
// #7: it nested the whole hydrated method, with its own `raw` inside, under
// data.raw.method — the wire body twice plus every parsed step).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { fakeFetch, runCommand, withTempEnvConfig, type FakeFetch, type RecordedRequest, type TempEnvConfig } from "@belzabar/core/testing";
import fetchCommand from "../../commands/fetch/index";

const FIX = join(import.meta.dir, "../fixtures");
const UUID = "4f6331f11208e5ccc8ddaaad20727664";
const wireBody = () => JSON.parse(readFileSync(join(FIX, "real-v1", `${UUID}.v1.json`), "utf8"));
const defTemplate = () => JSON.parse(readFileSync(join(FIX, "definitions", "976.json"), "utf8"));

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = null;
  cfg = null;
});

test("fetch --raw: data.raw is the wire body, once", async () => {
  cfg = withTempEnvConfig({ envs: { "t-fetch": { url: "https://t-dev.test" } }, activeEnv: "t-fetch" });
  ff = fakeFetch([
    { method: "GET", url: `/rest/api/automation/chain/${UUID}`, response: wireBody() },
    {
      method: "GET",
      url: /\/rest\/api\/automations\/(\d+)/,
      response: (req: RecordedRequest) => ({ ...defTemplate(), id: Number(/automations\/(\d+)/.exec(req.url)![1]) }),
    },
  ]).install();
  const r = await runCommand(fetchCommand, [UUID, "--raw"], { env: "t-fetch" });
  expect(r.envelope?.ok).toBe(true);
  const data = r.envelope?.data as { raw: unknown; method: { uuid: string } };
  expect(data.method.uuid).toBe(UUID);
  expect(data.raw).toEqual(wireBody());
  const plain = await runCommand(fetchCommand, [UUID], { env: "t-fetch" });
  expect((plain.envelope?.data as { raw?: unknown }).raw).toBeUndefined();
});
