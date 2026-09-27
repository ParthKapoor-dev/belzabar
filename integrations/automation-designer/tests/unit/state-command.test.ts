// `ad state`: sync is a content question (AD-18 / F35), `versions` is in the
// data as the help promises (F35), and each side is fetched once (AD-39).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { fakeFetch, runCommand, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import stateCommand from "../../commands/state/index";

const FIX = join(import.meta.dir, "../fixtures/history");
const DRAFT = "4bdea25c480a8e9dbc1cae830cb89b68";
const PUB = "0000000000000000000000000000beef";
const draftBody = () => JSON.parse(readFileSync(join(FIX, "chain-v1-draft.json"), "utf8"));

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
});

/** A published sibling of the real draft: same logic, independent version counter. */
function pair(opts: { draftCode?: string } = {}) {
  const draft = { ...draftBody(), referenceId: PUB, version: 12 };
  if (opts.draftCode) {
    const inner = JSON.parse(draft.jsonDefinition);
    inner.services[0].code = opts.draftCode;
    draft.jsonDefinition = JSON.stringify(inner);
  }
  const pub = { ...draftBody(), uuid: PUB, automationState: "PUBLISHED", referenceId: DRAFT, version: 8 };
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  ff = fakeFetch({
    [`GET /rest/api/automation/chain/${DRAFT}`]: draft,
    [`GET /rest/api/automation/chain/${PUB}`]: pub,
  }).install();
  return ff;
}

describe("ad state", () => {
  test("draft v12 vs published v8 with identical logic -> inSync:true (not 'draft ahead')", async () => {
    pair();
    const r = await runCommand(stateCommand, [PUB], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(r.envelope?.ok).toBe(true);
    expect(d.versions).toEqual({ draft: 12, published: 8 });
    expect(d.inSync).toBe(true);
    expect(d.fingerprints.draft).toBe(d.fingerprints.published);
    expect(d.switchedFromPublished).toBe(true);
  });

  test("different draft code -> inSync:false", async () => {
    pair({ draftCode: 'console.log("changed");' });
    const r = await runCommand(stateCommand, [DRAFT], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.inSync).toBe(false);
    expect(d.draftUuid).toBe(DRAFT);
    expect(d.publishedUuid).toBe(PUB);
  });

  test("one GET per side (AD-39)", async () => {
    const f = pair();
    await runCommand(stateCommand, [PUB], { env: "t-dev" });
    const gets = f.requests.filter((q) => q.method === "GET").map((q) => q.url.split("/").pop());
    expect(gets.sort()).toEqual([PUB, DRAFT].sort());
    f.requests.length = 0;
    await runCommand(stateCommand, [DRAFT], { env: "t-dev" });
    expect(f.requests.filter((q) => q.method === "GET")).toHaveLength(2);
  });

  test("never-published draft -> inSync:null", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch({ [`GET /rest/api/automation/chain/${DRAFT}`]: draftBody() }).install();
    const r = await runCommand(stateCommand, [DRAFT], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.inSync).toBeNull();
    expect(d.versions).toEqual({ draft: 4, published: null });
  });
});
